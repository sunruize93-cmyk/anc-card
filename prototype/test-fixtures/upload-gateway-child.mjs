// Isolated fault-test process. Never reads production configuration or credentials.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createMobileHandler } from '../mobile-gateway.mjs';
const [database, configFile, upstream] = process.argv.slice(2);
const loadConfig = () => JSON.parse(readFileSync(configFile, 'utf8'));
const db = new DatabaseSync(database);
let handler;
const server = createServer((req, res) => handler(req, res));
server.listen(0, '127.0.0.1', () => {
  const host = '127.0.0.1:' + server.address().port;
  handler = createMobileHandler({ config: loadConfig(), loadConfig, db, host, upstream });
  process.send({ url: 'http://' + host });
});
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => { db.close(); process.exit(0); });
});
