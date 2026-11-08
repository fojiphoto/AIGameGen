import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname), test=process.argv.includes('--test');
const out=resolve(root,'build',test?'test':'web'); await mkdir(out,{recursive:true});
await build({entryPoints:[resolve(root,'src',test?'core/index.ts':'main.ts')],outfile:resolve(out,test?'core.mjs':'game.js'),bundle:true,format:test?'esm':'iife',platform:'browser',target:'es2020',minify:!test,sourcemap:test?'inline':false});
if(!test)for(const f of ['index.html','style.css'])await copyFile(resolve(root,'src/shell',f),resolve(out,f));
console.log('Shadow Dash built:',out);
