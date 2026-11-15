import { inspectUploadReadiness } from '../upload-readiness.mjs';
import { resolve } from 'node:path';
const [directory, baseURL, portText='4785'] = process.argv.slice(2);
const port = Number(portText);
if (!directory || !baseURL || !Number.isInteger(port) || port<1 || port>65535) {
  throw Error('Usage: node prototype/scripts/check-upload-readiness.mjs UPLOAD_DIR HTTPS_BASE_URL [LOCAL_MAIN_PORT]');
}
const report = await inspectUploadReadiness({directory:resolve(directory),baseURL,port});
console.log(JSON.stringify(report,null,2));
if (!report.ready) process.exitCode=1;
