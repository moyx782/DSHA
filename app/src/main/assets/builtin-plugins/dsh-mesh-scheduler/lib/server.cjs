'use strict';
const fs = require('node:fs/promises');
const {plan,listNodes,validateInventory} = require('./scheduler.cjs');
const MAX_INVENTORY_BYTES = 128*1024;
const defaultInventoryFile = '/root/.dsh/mesh-nodes.json';
const taskFields = {
  id:{type:'string',maxLength:64},
  kind:{type:'string',enum:['cpu','gpu','android','general']},
  minCpuCores:{type:'integer',minimum:0},
  minMemoryMb:{type:'integer',minimum:0},
  minVramMb:{type:'integer',minimum:0},
  requiresCuda:{type:'boolean'},
  requiredCapabilities:{type:'array',items:{type:'string',maxLength:64},maxItems:16},
  preferredNodeId:{type:'string',maxLength:64},
  sourceNodeId:{type:'string',maxLength:64},
  sourceRegion:{type:'string',maxLength:64},
  dataPolicy:{type:'string',enum:['paired-only','local-only']},
  maxLatencyMs:{type:'integer',minimum:0}
};
const tools=[
  {name:'mesh_list_nodes',description:'列出已配置节点及其资源和心跳新鲜度。配置不是网络认证或可信实时遥测。',
   inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'mesh_plan_task',description:'按CPU、GPU、CUDA、显存、设备能力、负载及数据位置规划目标节点；仅规划、不执行。',
   inputSchema:{type:'object',properties:taskFields,required:['kind'],additionalProperties:false}}
];
const failure=code=>({ok:false,status:code,executionStarted:false});
async function readInventory(dependencies={}) {
  const io=dependencies.fs || fs;
  const filename=dependencies.filename || process.env.DSHA_MESH_NODES_FILE || defaultInventoryFile;
  let body;
  try {body=await io.readFile(filename,'utf8');}
  catch(error) {
    if(error&&error.code==='ENOENT') throw Error('MESH_NOT_CONFIGURED');
    throw Error('MESH_INVENTORY_UNAVAILABLE');
  }
  if(Buffer.byteLength(body,'utf8')>MAX_INVENTORY_BYTES) throw Error('MESH_INVENTORY_TOO_LARGE');
  let data;
  try {data=JSON.parse(body);}catch{throw Error('MESH_INVENTORY_INVALID_JSON');}
  if(!data||data.schema!==1) throw Error('MESH_INVENTORY_SCHEMA');
  return validateInventory(data.nodes);
}
async function perform(name,args={},dependencies={}) {
  if(!tools.some(t=>t.name===name)) return failure('UNKNOWN_TOOL');
  if(!args||typeof args!=='object'||Array.isArray(args)||
     (name==='mesh_list_nodes'&&Object.keys(args).length!==0)) return failure('INVALID_ARGUMENTS');
  try {
    const inventory=await (dependencies.loadInventory||readInventory)();
    if(name==='mesh_list_nodes')
      return {ok:true,status:'configured',executionStarted:false,inventoryVerified:false,
        nodes:listNodes(inventory,dependencies.now??Date.now())};
    return plan(args,inventory,dependencies.now??Date.now());
  } catch(error) {
    const code=typeof error?.message==='string'&&/^[A-Z][A-Z0-9_]{2,64}$/.test(error.message)
      ? error.message : 'MESH_UNAVAILABLE';
    return failure(code);
  }
}
function startServer() {
  let buffer='',pending=0,queue=Promise.resolve();
  const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  async function receive(request) {
    const {id,method}=request;
    const params=request.params||{};
    if(id===undefined||method==='notifications/cancelled') return;
    if(method==='initialize') {
      send({id,result:{protocolVersion:params.protocolVersion||'2025-03-26',
        capabilities:{tools:{listChanged:false}},
        serverInfo:{name:'DSHA Mesh Scheduler',version:'0.1.0'},
        instructions:'Only plan tasks. Do not report execution. Trust/online values are local declarations, not remote attestations; reject stale nodes.'}});
      return;
    }
    if(method==='ping') {send({id,result:{}});return;}
    if(method==='tools/list') {send({id,result:{tools}});return;}
    if(method==='tools/call') {
      const result=await perform(params.name,params.arguments||{});
      send({id,result:{content:[{type:'text',text:JSON.stringify(result)}],isError:!result.ok}});
      return;
    }
    send({id,error:{code:-32601,message:'Method not found'}});
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{
    buffer+=chunk;
    if(buffer.length>1024*1024){process.stderr.write('MESH_INPUT_LIMIT\n');process.exit(1);}
    let end;
    while((end=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      if(!line.trim()) continue;
      let parsed;
      try{parsed=JSON.parse(line);}catch{send({id:null,error:{code:-32700,message:'Parse error'}});continue;}
      if(pending>=32){send({id:parsed.id??null,error:{code:-32000,message:'Queue full'}});continue;}
      pending++;
      queue=queue.then(()=>receive(parsed)).catch(()=>{
        send({id:parsed.id??null,result:{content:[{type:'text',text:JSON.stringify(failure('MESH_UNAVAILABLE'))}],isError:true}});
      }).finally(()=>pending--);
    }
  });
  process.stdout.on('error',e=>{if(e.code==='EPIPE') process.exit(0);});
}
if(require.main===module) startServer();
module.exports={tools,perform,readInventory};
