"use strict";
// A bounded, short diagnostic soak. Not a substitute for a multi-day leak test.
const Rlog = require("../dist/index.js");
const { Writable } = require("node:stream");

const capRecords = 96, capBytes = 96 * 1024;
let streamWrites = 0, transportWrites = 0;
const sink = new Writable({
  write(_chunk, _encoding, done) { streamWrites++; done(); }
});
const transport = {
  async write(_record) {
    transportWrites++;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};

(async()=>{
  const logger = new Rlog({
    screenOutput:"none",
    jsonlOutput:sink,
    jsonlLogLevel:"debug",
    maxQueuedRecords:capRecords,
    maxQueuedBytes:capBytes,
    maxRecordBytes:4096,
    queueOverflowPolicy:"drop-debug",
    flightRecorder:{maxRecords:80,maxBytes:24576},
    transports:[transport],
  });
  const rss=[],heap=[],samples=[];
  const started = Date.now();
  for(let batch=0;batch<60;batch++){
    for(let i=0;i<80;i++)logger.jsonl.debug("soak",{batch,i,group:"slow-transport"});
    const s=logger.diagnostics();
    if(s.queuedRecords>capRecords || s.queuedBytes>capBytes)throw new Error("queue exceeded budget");
    samples.push(s.queuedRecords);
    rss.push(process.memoryUsage().rss);
    heap.push(process.memoryUsage().heapUsed);
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  const beforeDrain=logger.diagnostics();
  await logger.close();
  const end=logger.diagnostics();
  if(end.queuedRecords!==0 || end.queuedBytes!==0)throw new Error("pending work remained");
  console.log("SOAK",JSON.stringify({
    attempted:4800,delivered:streamWrites,transportWrites,
    dropped:beforeDrain.droppedRecords,durationMs:Date.now()-started,
    peakQueue:Math.max(...samples),peakRssMiB:+(Math.max(...rss)/1048576).toFixed(1),
    firstRssMiB:+(rss[0]/1048576).toFixed(1),
    lastRssMiB:+(rss.at(-1)/1048576).toFixed(1),
    peakHeapMiB:+(Math.max(...heap)/1048576).toFixed(1),
    queuedAfterClose:end.queuedRecords,flightRecords:logger.flightRecorderStatus().records,
  }));
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
