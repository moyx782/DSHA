'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {plan, listNodes} = require('../app/src/main/assets/builtin-plugins/dsh-mesh-scheduler/lib/scheduler.cjs');
const NOW = 1800000000000;
function peer(id, role, changes={}) {
  return {
    id, role, paired:true, online:true, observedAt:NOW,
    availableCpuCores:12, availableMemoryMb:32768,
    gpuBackend:'none', availableVramMb:0,
    activeJobs:0, maxJobs:2, latencyMs:10,
    capabilities:[], ...changes
  };
}
const mac = peer('mac','mac',{availableCpuCores:10});
const pc = peer('pc','workstation',{gpuBackend:'cuda',availableVramMb:12288});
const phone = peer('phone','android',{availableCpuCores:4,availableMemoryMb:4096});
test('CPU inference prefers a healthy Mac', () => {
  const result=plan({kind:'cpu',minCpuCores:8},[pc,mac,phone],NOW);
  assert.equal(result.nodeId,'mac');
  assert.equal(result.executionStarted,false);
});
test('GPU work prefers the CUDA workstation', () => {
  assert.equal(plan({kind:'gpu',minVramMb:8192,requiresCuda:true},[
    {...mac,gpuBackend:'metal',availableVramMb:16000},pc],NOW).nodeId,'pc');
});
test('Android operations go to the phone', () => {
  assert.equal(plan({kind:'android'},[mac,pc,phone],NOW).nodeId,'phone');
});
test('GPU limits fail closed instead of silently routing to CPU', () => {
  const p=plan({kind:'gpu',minVramMb:24576},[pc,mac],NOW);
  assert.equal(p.ok,false);
  assert.equal(p.status,'no-eligible-node');
});
test('Fallback to workstation when Mac is offline', () => {
  assert.equal(plan({kind:'cpu'},[{...mac,online:false},pc],NOW).nodeId,'pc');
});
test('Stale heartbeat and unpaired nodes are never eligible', () => {
  const p=plan({kind:'gpu'},[
    {...pc,observedAt:NOW-60001}, {...mac,gpuBackend:'metal',availableVramMb:8192,paired:false}],NOW);
  assert.equal(p.ok,false);
  assert.deepEqual(p.exclusions.map(x=>x.reason),
    ['HEARTBEAT_STALE_OR_UNVERIFIED','NOT_PAIRED']);
});
test('Data-local-only policy prevents a remote assignment', () => {
  const p=plan({kind:'gpu',dataPolicy:'local-only',sourceNodeId:'mac'},[mac,pc],NOW);
  assert.equal(p.ok,false);
  assert.equal(p.exclusions[1].reason,'LOCAL_ONLY');
});
test('Fully occupied nodes are excluded', () => {
  const p=plan({kind:'cpu'},[{...mac,activeJobs:2},pc],NOW);
  assert.equal(p.nodeId,'pc');
});
test('Required CUDA and tools must both exist', () => {
  const p=plan({kind:'gpu',requiresCuda:true,requiredCapabilities:['pytorch']},[pc],NOW);
  assert.equal(p.ok,false);
  assert.equal(p.exclusions[0].reason,'CAPABILITY_MISSING');
});
test('Malformed inventory and task are rejected without guessing', () => {
  assert.throws(()=>plan({kind:'unknown'},[mac],NOW),/INVALID_TASK_KIND/);
  assert.throws(()=>plan({kind:'cpu'},[mac,mac],NOW),/INVALID_NODE_ID_OR_ROLE/);
  assert.throws(()=>plan({kind:'cpu',dataPolicy:'local-only'},[mac],NOW),/LOCAL_ONLY_REQUIRES_SOURCE/);
});
test('Node enumeration drops unknown config fields and notes lack of attestation', () => {
  const [n]=listNodes([{...pc,secret:'DO_NOT_EXPOSE'}],NOW);
  assert.equal(n.secret,undefined);
  assert.equal(n.verification,'configured-not-attested');
  assert.equal(n.heartbeatFresh,true);
});

const {perform,readInventory} = require('../app/src/main/assets/builtin-plugins/dsh-mesh-scheduler/lib/server.cjs');
test('MCP AI planning tool routes without executing', async () => {
  const loadInventory=async()=>[mac,pc,phone];
  const result=await perform('mesh_plan_task',{kind:'gpu',requiresCuda:true,minVramMb:8192},
    {loadInventory,now:NOW});
  assert.equal(result.ok,true);
  assert.equal(result.nodeId,'pc');
  assert.equal(result.executionStarted,false);
  const listing=await perform('mesh_list_nodes',{}, {loadInventory,now:NOW});
  assert.equal(listing.nodes.length,3);
  assert.equal(listing.inventoryVerified,false);
});
test('MCP inventory fails closed when it is not configured', async () => {
  const unavailable=Object.assign(new Error('missing'),{code:'ENOENT'});
  const inventory={fs:{readFile:async()=>{throw unavailable;}},filename:'/does-not-exist'};
  await assert.rejects(readInventory(inventory),/MESH_NOT_CONFIGURED/);
  const result=await perform('mesh_plan_task',{kind:'cpu'},{
    loadInventory:async()=>readInventory(inventory),now:NOW
  });
  assert.equal(result.ok,false);
  assert.equal(result.status,'MESH_NOT_CONFIGURED');
});
