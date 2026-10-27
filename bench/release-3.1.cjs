"use strict";
// Run with: RLOG_BENCH_BASELINE=<absolute path to an older rlog-js entry> node bench/release-3.1.cjs
// Relative numbers are exploratory. No timing pass/fail thresholds.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const Current = require("../dist/index.js");
const Base = process.env.RLOG_BENCH_BASELINE ? require(process.env.RLOG_BENCH_BASELINE) : null;
const count = 2500;
const rounds = 5;
const conditions = [
  ...(Base ? [["baseline-default", Base, () => ({})]] : []),
  ["3.1-default", Current, () => ({})],
  ["3.1-byte-budget", Current, () => ({
    maxQueuedRecords: 3500, maxQueuedBytes: 16 * 1024 * 1024, maxRecordBytes: 16384
  })],
  ["3.1-processor", Current, () => ({
    processors: [rec => { rec.context = { ...rec.context, tag: "perf" }; return rec; }]
  })],
  ["3.1-flight", Current, () => ({
    flightRecorder: { maxRecords: 150, maxBytes: 65536, captureLevels: ["info"] }
  })],
];
function median(nums) {
  const ordered = [...nums].sort((a,b) => a-b);
  return ordered[Math.floor(ordered.length/2)];
}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"rlog31-bench-"));
(async()=>{
  const data=new Map(conditions.map(([name])=>[name,[]]));
  for (let round = 0; round < rounds; round++) {
    const ordered = round%2 ? [...conditions].reverse() : conditions;
    for (const [name, Ctor, overrides] of ordered) {
      const file = path.join(tmp, name+"-"+round+".jsonl");
      const logger = new Ctor({
        screenOutput:"none",jsonlFilePath:file,jsonlLogLevel:"info",...overrides()
      });
      const start=performance.now();
      for (let i=0; i<count; i++) logger.jsonl.event("benchmark", {i,tag:"rlog",ok:true});
      await logger.close();
      const elapsed=performance.now()-start;
      const payload=fs.readFileSync(file,"utf8");
      const lines=payload.trim().split("\n").length;
      if(lines!==count)throw new Error(name+" lost records: "+lines+"/"+count);
      data.get(name).push({ms:elapsed,rps:count*1000/elapsed});
    }
  }
  for(const [name,values] of data) {
    const row={name,rounds:values.length,recordsPerRound:count,
      medianMs:Math.round(median(values.map(v=>v.ms))*10)/10,
      medianRecordsPerSec:Math.round(median(values.map(v=>v.rps))),
      minRecordsPerSec:Math.round(Math.min(...values.map(v=>v.rps))),
      maxRecordsPerSec:Math.round(Math.max(...values.map(v=>v.rps)))};
    console.log("BENCH",JSON.stringify(row));
  }
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;})
.finally(()=>{try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}});
