#!/usr/bin/env node
import{qa as s,ra as e,sa as n}from"./chunk-U5PLAZAN.js";e(process.argv)?s().parse(process.argv):n().then(({program:r,warnings:o})=>{for(let i of o)process.stderr.write(`aih: plugin: ${i}
`);return r.parseAsync(process.argv)}).catch(r=>{process.stderr.write(`fatal: ${r instanceof Error?r.message:String(r)}
`),process.exitCode=1});
