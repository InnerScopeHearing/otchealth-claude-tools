import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
function fixture(t) {
  const tmp = resolve(tmpdir());
  const root = mkdtempSync(join(tmp, "digest cli-"));
  assert.equal(resolve(dirname(root)).toLowerCase(), tmp.toLowerCase());
  t.after(() => { assert.equal(resolve(dirname(root)).toLowerCase(), tmp.toLowerCase()); rmSync(root, { recursive: true, force: true }); });
  const skills = join(root, "skills");
  mkdirSync(join(skills, "daily-digest"), { recursive:true });
  mkdirSync(join(skills, "github-app"), { recursive:true });
  const script=join(skills,"daily-digest","digest.mjs");
  writeFileSync(script,readFileSync(new URL("../skills/daily-digest/digest.mjs",import.meta.url)));
  writeFileSync(join(skills,"github-app","gh-app.mjs"), `if (process.env.SYNTHETIC_FAIL === '1') process.exit(2); console.log(JSON.stringify({data:{search:{nodes:[{number:12,title:'Synthetic PR',repository:{name:'example'}}]}}}));`);
  return {root,skills,script,out:join(root,"output folder","digest.md")};
}
function run(script,args=[],env={}) { return spawnSync(process.execPath,[script,...args],{encoding:"utf8",timeout:15000,env:{...process.env,...env}}); }
test("direct invocation uses fake helper and writes a synthetic digest in a path with spaces",t=>{
  const f=fixture(t); const r=run(f.script,["--date","2026-01-01","--out",f.out]);
  assert.equal(r.status,0,r.stderr); assert.ok(existsSync(f.out)); assert.match(readFileSync(f.out,"utf8"),/#12 Synthetic PR/);
});
test("linked directory invocation uses the fake helper",t=>{
  const f=fixture(t); const link=join(f.root,"skills-link"); symlinkSync(f.skills,link,process.platform==='win32'?'junction':'dir');
  assert.equal(realpathSync(link).toLowerCase(),realpathSync(f.skills).toLowerCase());
  const r=run(join(link,"daily-digest","digest.mjs"),["--out",f.out]); assert.equal(r.status,0,r.stderr); assert.ok(existsSync(f.out));
});
test("importing the module does not execute its CLI",t=>{
  const f=fixture(t); const entry=join(f.root,"import-check.mjs");
  writeFileSync(entry,`import { digestQueryOk } from ${JSON.stringify(pathToFileURL(f.script).href)}; console.log(digestQueryOk({data:{search:{nodes:[]}}}));`);
  const r=run(entry); assert.equal(r.status,0); assert.match(r.stdout,/^true\s*$/); assert.equal(r.stderr,""); assert.equal(existsSync(f.out),false);
});
test("a failed fake helper exits nonzero without writing a digest",t=>{
  const f=fixture(t); const r=run(f.script,["--out",f.out],{SYNTHETIC_FAIL:"1"});
  assert.equal(r.status,4,r.stderr); assert.match(r.stderr,/Refusing to write/); assert.equal(existsSync(f.out),false);
});