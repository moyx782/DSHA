import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { fileURLToPath } from 'node:url';

// 远端执行器尚未接入，这个 MCP 插件只提供规划决策。
export const name = 'dsh-mesh-scheduler';
export const inject = ['tools'];
export async function apply(ctx) {
  const config = McpClient.Config({
    transport:'stdio', serverName:'dsha-mesh',
    command:process.execPath,
    args:[fileURLToPath(new URL('./server.cjs',import.meta.url))],
    failOnStartupError:true, toolCallTimeoutMs:15000, reconnect:{enabled:false}
  });
  let child;
  ctx.effect(function* () {
    child = ctx.plugin(McpClient,config);
    yield child.dispose;
  },'dsha-mesh-scheduler');
  await child.await();
}
