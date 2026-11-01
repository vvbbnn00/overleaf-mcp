#!/usr/bin/env node
import { browserLogin, inspectSavedSession } from './session.js';
import { OverleafClient } from './client.js';
import { serve } from './mcp.js';
import { safeErrorMessage } from './errors.js';

async function main() {
  const command = process.argv[2];
  const usage = 'Usage: overleaf-mcp <command>\nCommands: login | status | serve | list | project <id> | read/watch <id> <path> | history <id>';
  if (!command || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (command === 'serve') return serve();
  if (command === 'login') return browserLogin();
  if (command === 'status') {
    console.log(JSON.stringify(await inspectSavedSession(), null, 2));
    return;
  }
  if (['list', 'project', 'read', 'watch', 'history'].includes(command)) {
    const client = await OverleafClient.connect();
    const projectId = process.argv[3];
    const path = process.argv[4];
    try {
      if (command === 'list') console.log(JSON.stringify(await client.listProjects(), null, 2));
      if (command === 'project') console.log(JSON.stringify(await client.getProject(projectId), null, 2));
      if (command === 'read') console.log(JSON.stringify(await client.readFile(projectId, path), null, 2));
      if (command === 'history') console.log(JSON.stringify(await client.history(projectId), null, 2));
      if (command === 'watch') {
        client.on('change', event => console.log(JSON.stringify(event)));
        await client.watchFile(projectId, path);
        await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
      }
    } finally { await client.close(); }
    return;
  }
  throw new Error(usage);
}

main().catch(error => { console.error(safeErrorMessage(error)); process.exitCode = 1; });
