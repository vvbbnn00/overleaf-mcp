import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OverleafClient } from '../dist/client.js';

function png(rgba) {
  const chunk = (type, data) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, content, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, ...rgba]))), chunk('IEND', Buffer.alloc(0))]);
}
function pdf() {
  const stream = 'BT /F1 12 Tf 20 30 Td (Upload test) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let result = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

const projectId = process.argv[2];
const directory = await mkdtemp(join(tmpdir(), 'overleaf-upload-smoke-'));
const backend = await OverleafClient.connect();
const client = new Client({ name: 'upload-acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'serve'], cwd: process.cwd(), stderr: 'inherit' });
let folderId;
try {
  assert.equal((await backend.getProject(projectId)).name, 'TestForMCP');
  const before = await backend.readFile(projectId, 'main.tex');
  const folderName = `mcp-upload-test-${randomUUID().slice(0, 8)}`;
  folderId = (await backend.request(`/project/${projectId}/folder`, 'POST', { name: folderName }))._id;
  assert.ok(folderId);
  await client.connect(transport);
  const upload = async (filename, overwrite) => {
    const result = await client.callTool({ name: 'upload_file', arguments: { projectId, localPath: join(directory, filename), path: `${folderName}/${filename}`, ...(overwrite === undefined ? {} : { overwrite }) } });
    return result;
  };
  for (const [name, bytes] of [['source.tex', Buffer.from('% 中文上传测试\r\n\\documentclass{article}\r\n')], ['pixel.png', png([255, 0, 0, 255])], ['page.pdf', pdf()], ['.latexmkrc', Buffer.from('$pdf_mode = 1;\n')], ['a.' + 'x'.repeat(147), Buffer.from('long filename upload')]]) {
    await writeFile(join(directory, name), bytes);
    const result = await upload(name);
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const value = result.structuredContent;
    assert.equal(value.uploaded, true); assert.equal(value.verified, true, value.error ?? value.warning);
    if (name === '.latexmkrc') assert.equal(value.entityType, 'doc');
    console.log(JSON.stringify({ check: 'upload', name, entityType: value.entityType, contentMatch: value.contentMatch, overwriteAllowed: value.overwriteAllowed }));
  }
  const denied = await upload('pixel.png');
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /FILE_EXISTS/);
  await writeFile(join(directory, 'pixel.png'), png([0, 0, 255, 255]));
  const replaced = await upload('pixel.png', true);
  assert.notEqual(replaced.isError, true, replaced.content?.[0]?.text);
  assert.equal(replaced.structuredContent.verified, true);
  assert.equal(replaced.structuredContent.overwriteAllowed, true);
  assert.ok(replaced.structuredContent.existingBeforeUpload);
  await writeFile(join(directory, 'source.tex'), '% 中文覆盖测试\n');
  const text = await upload('source.tex', true);
  assert.notEqual(text.isError, true, text.content?.[0]?.text);
  assert.equal(text.structuredContent.verified, true);
  console.log(JSON.stringify({ check: 'overwrite', defaultRejected: true, binaryVerified: true, textVerified: true }));
  assert.equal((await backend.readFile(projectId, 'main.tex')).content, before.content);
  console.log(JSON.stringify({ check: 'existing-main-preserved', passed: true }));
} finally {
  await client.close();
  if (folderId) await backend.request(`/project/${projectId}/folder/${folderId}`, 'DELETE');
  await backend.close();
  await rm(directory, { recursive: true, force: true });
}
