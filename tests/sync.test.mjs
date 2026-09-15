import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const bundle = await build({ stdin: { contents: `
export {SyncEngine} from './src/sync/engine';
export {SyncState} from './src/sync/state';
export {ManifestManager} from './src/sync/manifest';
export {DeletionTracker} from './src/sync/deletions';
export {computeSyncPlan} from './src/sync/differ';
export {TFile} from 'obsidian';
export {SynologyClient} from './src/api/client';
export {normalizeRemoteFolder,remoteFilePath} from './src/api/paths';
export {listRemoteFiles,readRemoteRecord} from './src/sync/remote-access';
export {diagnoseLockRead} from './src/sync/lock-diagnostics';
export {withRemoteDiagnostics} from './src/sync/remote-diagnostics';`, resolveDir: process.cwd() },
    bundle: true, format: 'esm', platform: 'node', write: false,
    plugins: [{ name: 'obsidian-double', setup(b) {
        b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
        b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
export class TFile { constructor(path, size, mtime) {this.path=path;this.name=path.split('/').pop();this.stat={size,mtime};} }
export class Notice { hide() {} }
export const getLanguage=()=> 'en';
export const requestUrl=(req)=>globalThis.mockRequest(req);` }));
    } }]
});
const {SyncEngine, SyncState, ManifestManager, DeletionTracker, computeSyncPlan, TFile, SynologyClient, normalizeRemoteFolder, remoteFilePath, listRemoteFiles, readRemoteRecord, withRemoteDiagnostics, diagnoseLockRead} = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.crypto ??= webcrypto;
globalThis.window ??= {setTimeout};
Error.stackTraceLimit = 3;
const bytes = text => new TextEncoder().encode(text).buffer;
const text = buffer => new TextDecoder().decode(buffer);
const root = '/mydrive/test';
const hash = async buffer => Buffer.from(await crypto.subtle.digest('SHA-256',buffer)).toString('hex');
const json = value => bytes(JSON.stringify(value));

class Remote {
    files = new Map();
    folders = new Set([root]);
    writes = [];
    fail = null;
    async ensureRemoteFolder(path) { this.folders.add(path); }
    async hasFile(path) { return this.files.has(path) || this.folders.has(path); }
    async createFolder(path, action) {
        if (await this.hasFile(path)) { if (action === 'stop') throw Error('exists'); return; }
        // No await between the final existence check and creation, just like an exclusive server create.
        if (this.folders.has(path)) throw Error('exists');
        this.folders.add(path);
        return {success:true};
    }
    async uploadFile(path, buffer) {
        this.fail?.('upload',path);
        if (this.folders.has(path)) throw Error('is directory');
        this.files.set(path,buffer.slice(0)); this.writes.push(path);
    }
    async downloadFile(path) { this.fail?.('download',path); if (!this.files.has(path)) throw Error('missing ' + path); return this.files.get(path).slice(0); }
    async deleteFile(path) {
        this.fail?.('delete',path);
        this.files.delete(path); this.folders.delete(path);
        for (const key of this.files.keys()) if (key.startsWith(path+'/')) this.files.delete(key);
    }
    async listFiles(path) {
        this.fail?.('list',path);
        const items = new Map();
        for (const key of [...this.files.keys(),...this.folders]) {
            if (!key.startsWith(path+'/')) continue;
            const rest=key.slice(path.length+1); const name=rest.split('/')[0];
            items.set(name,{name,path:path+'/'+name,isdir:rest.includes('/')||this.folders.has(key)});
        }
        return {data:{total:items.size,items:[...items.values()]}};
    }
    manifest() { return JSON.parse(text(this.files.get(root+'/.sync_manifest.json'))); }
}
function device(remote, initial = {}, saved) {
    const contents=new Map(); const files=new Map(); const storage=new Map(); let tick=0;
    const put=(path,value)=> { const buffer=typeof value === 'string'?bytes(value):value; contents.set(path,buffer); files.set(path,new TFile(path,buffer.byteLength,++tick)); };
    for (const [path,value] of Object.entries(initial)) put(path,value);
    if(saved) storage.set('plugin/sync_data.json',saved);
    const app={vault:{configDir:'.obsidian',getFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path)??null,
        readBinary:async file=>contents.get(file.path).slice(0),
        process:async(file,fn)=>{const value=fn(text(contents.get(file.path)));put(file.path,value);return value;},
        modifyBinary:async(file,b)=>put(file.path,b),createBinary:async(p,b)=>put(p,b),createFolder:async()=>{},
        adapter:{exists:async p=>storage.has(p),read:async p=>storage.get(p),write:async(p,v)=>storage.set(p,v)}},
        fileManager:{trashFile:async file=>{files.delete(file.path);contents.delete(file.path);}}};
    const tracker=new DeletionTracker(); const logs=[];
    const state=new SyncState(app,'plugin','target');
    const engine=()=>new SyncEngine(app,remote,state,{addLog:async l=>logs.push(l),flush:async()=>{}},root,tracker);
    return {app,put,contents,storage,tracker,state,logs,engine,
        remove(path){tracker.deleted(path);contents.delete(path);files.delete(path);},
        read:p=>text(contents.get(p)),sync:()=>engine().runSync(true)};
}
async function seed(remote, path, content) {
    const b=bytes(content); remote.files.set(root+'/'+path,b);
    const manifest=remote.files.has(root+'/.sync_manifest.json')?remote.manifest():{schemaVersion:1,files:{}};
    manifest.files[path]={rev:1,hash:await hash(b),size:b.byteLength,updatedBy:'seed',updatedAt:1};
    remote.files.set(root+'/.sync_manifest.json',json(manifest));
}
async function stable(d,r) {
    await d.sync();const before=JSON.stringify(r.manifest());const count=r.writes.filter(p=>!p.includes('/.sync_')).length;
    for(let i=0;i<3;i++) await d.sync();
    assert.equal(JSON.stringify(r.manifest()),before);
    assert.equal(r.writes.filter(p=>!p.includes('/.sync_')).length,count);
    for (const [path,entry] of Object.entries(r.manifest().files)) {
        if (!entry.deleted) assert.equal(await hash(r.files.get(root+'/'+path)),entry.hash);
    }
    const saved=JSON.parse(d.storage.get('plugin/sync_data.json'));
    for (const [path,entry] of Object.entries(saved.files)) assert.equal(await hash(d.contents.get(path)),entry.localHash);
}

test('empty device with copied current snapshot downloads all files',async()=>{
    const r=new Remote(); const a=device(r,{'a.md':'A','b.md':'B'});await a.sync();
    const b=device(r,{},a.storage.get('plugin/sync_data.json'));await b.sync();
    assert.equal(b.read('a.md'),'A');assert.equal(b.read('b.md'),'B');assert.equal(r.manifest().files['a.md'].deleted,undefined);
    await stable(b,r);
});
test('legacy snapshots never authorize remote deletion',async()=>{
    const r=new Remote();await seed(r,'a.md','A');const d=device(r,{},JSON.stringify({schemaVersion:1,deviceId:'copy',files:{'a.md':{}}}));await d.sync();assert.equal(d.read('a.md'),'A');
});
test('exclusive directory allows only one simultaneous writer',async()=>{
    const r=new Remote();const a=new ManifestManager(r,root),b=new ManifestManager(r,root);
    const results=await Promise.allSettled([a.acquireLock('same-device'),b.acquireLock('same-device')]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    const owner=results[0].status==='fulfilled'?a:b;await owner.releaseLock('same-device');
});
test('lost ownership blocks manifest publication',async()=>{
    const r=new Remote();const m=new ManifestManager(r,root);await m.acquireLock('A');r.files.set(root+'/.sync_lock/owner.json',bytes('other'));
    await assert.rejects(m.uploadManifest({schemaVersion:1,files:{}},'A'));assert.equal(r.files.has(root+'/.sync_manifest.json'),false);
});
test('local deletion versus remote edit restores edited file and converges',async()=>{
    const r=new Remote();const a=device(r,{'a.md':'A'});await a.sync();a.remove('a.md');r.files.set(root+'/a.md',bytes('remote edit'));
    await a.sync();assert.equal(a.read('a.md'),'remote edit');assert.equal([...a.contents.keys()].length,1);await stable(a,r);
});
test('remote deletion versus local edit retains live edit',async()=>{
    const r=new Remote();const a=device(r,{'a.md':'A'});await a.sync();const b=device(r);await b.sync();a.remove('a.md');await a.sync();b.put('a.md','local edit');await b.sync();assert.equal(text(r.files.get(root+'/a.md')),'local edit');await stable(b,r);
});
test('different concurrent edits preserve both contents and converge',async()=>{
    const r=new Remote();const a=device(r,{'a.md':'A'});await a.sync();const b=device(r);await b.sync();a.put('a.md','edit A');b.put('a.md','edit B');await a.sync();await b.sync();await a.sync();
    assert.equal(a.read('a.md'),'edit B');assert.ok([...b.contents.values()].some(v=>text(v)==='edit A'));
    await stable(a,r);await stable(b,r);
});
test('normal remote-only edits do not generate conflict copies',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});await d.sync();r.files.set(root+'/a.md',bytes('B'));await d.sync();assert.equal(d.read('a.md'),'B');assert.deepEqual([...d.contents.keys()],['a.md']);
});
test('failed deletion does not publish tombstone, replay recovers',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});await d.sync();d.remove('a.md');r.fail=(op,p)=>{if(op==='delete'&&p===root+'/a.md')throw Error('permission');};
    await assert.rejects(d.sync(),/permission/);assert.equal(r.manifest().files['a.md'].deleted,undefined);assert.ok(r.files.has(root+'/.sync_pending.json'));
    r.fail=null;await d.sync();assert.equal(r.manifest().files['a.md'].deleted,true);assert.equal(r.files.has(root+'/a.md'),false);
});
test('file uploaded but manifest publication fails: replay before next plan',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});await d.sync();d.put('a.md','B');r.fail=(op,p)=>{if(op==='upload'&&p.endsWith('.sync_manifest.json'))throw Error('network');};
    await assert.rejects(d.sync(),/network/);assert.equal(text(r.files.get(root+'/a.md')),'B');assert.notEqual(r.manifest().files['a.md'].hash,await hash(bytes('B')));
    r.fail=null;await d.sync();assert.equal(r.manifest().files['a.md'].hash,await hash(bytes('B')));await stable(d,r);
});
test('disk save failure propagates and retry is idempotent',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});const write=d.app.vault.adapter.write;d.app.vault.adapter.write=async()=>{throw Error('disk full');};await assert.rejects(d.sync(),/disk full/);d.app.vault.adapter.write=write;await stable(d,r);
});
test('corrupt or unsupported manifest fails closed',async()=>{
    const r=new Remote();r.files.set(root+'/.sync_manifest.json',json({schemaVersion:99,files:{}}));const d=device(r,{'a.md':'A'});await assert.rejects(d.sync());assert.equal(r.files.has(root+'/a.md'),false);
});
test('listing failure prevents partial plans and deletions',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});await d.sync();d.remove('a.md');r.fail=(op)=>{if(op==='list')throw Error('permission');};await assert.rejects(d.sync());assert.ok(r.files.has(root+'/a.md'));
});
test('force upload never removes remote-only files; force download preserves local-only files',async()=>{
    const r=new Remote();await seed(r,'remote.md','R');const d=device(r,{'local.md':'L'});await d.engine().forceUpload();assert.ok(r.files.has(root+'/remote.md'));
    d.put('only-local.md','local');await d.engine().forceDownload();assert.equal(d.read('only-local.md'),'local');assert.equal(d.read('remote.md'),'R');
});
test('rebuild compares actual bytes rather than declaring equal by path',async()=>{
    const r=new Remote();await seed(r,'a.md','R');const d=device(r,{'a.md':'L'});await d.engine().rebuildSyncState();assert.equal(text(r.files.get(root+'/a.md')),'L');assert.ok([...d.contents.values()].some(v=>text(v)==='R'));await stable(d,r);
});
test('remote tombstones are never aged away',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});await d.sync();d.remove('a.md');await d.sync();const manifest=r.manifest();manifest.files['a.md'].deletedAt=1;r.files.set(root+'/.sync_manifest.json',json(manifest));await d.sync();assert.equal(r.manifest().files['a.md'].deleted,true);
});
test('bulk observed deletions are blocked before mutation',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A','b.md':'B'});await d.sync();d.remove('a.md');d.remove('b.md');await assert.rejects(d.sync(),/Bulk deletion/);assert.ok(r.files.has(root+'/a.md'));assert.ok(r.files.has(root+'/b.md'));
});
test('decision default never trusts mere absence',()=>{
    const entry={hash:'a'.repeat(64),rev:1};const snap={localHash:entry.hash,syncedRev:1};
    const plan=computeSyncPlan(new Map(),new Map([['a.md',snap]]),new Map([['a.md',entry]]));assert.equal(plan.deletionsRemote.size,0);assert.ok(plan.downloads.has('a.md'));
});

test('quick sync refuses to overwrite a remote edit outside the protocol',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});await d.sync();d.put('a.md','local');r.files.set(root+'/a.md',bytes('external'));
    await assert.rejects(d.engine().runSync(false));assert.equal(text(r.files.get(root+'/a.md')),'external');await d.sync();assert.ok([...d.contents.values()].some(v=>text(v)==='external'));
});
test('quick sync consumes another device committed revision',async()=>{
    const r=new Remote();const a=device(r,{'a.md':'A'});await a.sync();const b=device(r);await b.sync();a.put('a.md','B');await a.engine().runSync(false);await b.engine().runSync(false);assert.equal(b.read('a.md'),'B');
});
test('upload hash tracks actual bytes even when mtime does not change',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});await d.sync();const file=d.app.vault.getAbstractFileByPath('a.md');const oldTime=file.stat.mtime;d.put('a.md','B');d.app.vault.getAbstractFileByPath('a.md').stat.mtime=oldTime;await d.sync();assert.equal(r.manifest().files['a.md'].hash,await hash(bytes('B')));
});
test('editing locally during a planned download aborts without overwrite',async()=>{
    const r=new Remote();const a=device(r,{'a.md':'A'});await a.sync();const b=device(r);await b.sync();a.put('a.md','remote');await a.sync();
    const original=r.downloadFile.bind(r);let once=true;r.downloadFile=async p=>{if(p===root+'/a.md'&&once){once=false;b.put('a.md','unsaved latest');}return original(p);};
    await assert.rejects(b.engine().runSync(false));assert.equal(b.read('a.md'),'unsaved latest');
});
test('pending journal survives failure before content write and replays next time',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});r.fail=(op,p)=>{if(op==='upload'&&p===root+'/a.md')throw Error('disconnect');};await assert.rejects(d.sync());assert.ok(r.files.has(root+'/.sync_pending.json'));assert.equal(r.files.has(root+'/a.md'),false);r.fail=null;await d.sync();assert.equal(text(r.files.get(root+'/a.md')),'A');await stable(d,r);
});
test('unknown local content against a tombstone is preserved once without revival',async()=>{
    const r=new Remote();const a=device(r,{'a.md':'A'});await a.sync();a.remove('a.md');await a.sync();const b=device(r,{'a.md':'old offline copy'});await b.sync();assert.equal(b.contents.has('a.md'),false);assert.ok([...b.contents.values()].some(v=>text(v)==='old offline copy'));await stable(b,r);assert.equal(r.manifest().files['a.md'].deleted,true);
});
test('foreign target snapshots are discarded',async()=>{
    const r=new Remote();const a=device(r,{'a.md':'A'});await a.sync();const state=JSON.parse(a.storage.get('plugin/sync_data.json'));state.target='another NAS';const b=device(r,{},JSON.stringify(state));await b.sync();assert.equal(b.read('a.md'),'A');
});
function response(value,status=200){const body=JSON.stringify(value);return {status,text:body,json:value,headers:{},arrayBuffer:bytes(body)};}
test('API HTTP 200 business errors reject deletion',async()=>{
    globalThis.mockRequest=async()=>response({success:false,error:{code:1000}});
    await assert.rejects(new SynologyClient('https://nas.test','user').deleteFile('/mydrive/a.md'),/1000/);
});
test('exclusive create sends stop without changing legacy response handling',async()=>{
    let request;globalThis.mockRequest=async req=>{request=req;return response({});};
    assert.deepEqual(await new SynologyClient('https://nas.test','user').createFolder('/mydrive/.sync_lock','stop'),{});
    assert.equal(new URL(request.url).searchParams.get('conflict_action'),'stop');
});
test('API listing collects multiple pages',async()=>{
    const offsets=[];globalThis.mockRequest=async req=>{const offset=Number(new URL(req.url).searchParams.get('offset'));offsets.push(offset);return response({success:true,data:{items:offset===0?Array.from({length:200},(_,i)=>({name:String(i)})):[{name:'last'}],has_more:offset===0}});};
    const result=await new SynologyClient('https://nas.test','user').listFiles('/mydrive/test');assert.equal(result.data.items.length,201);assert.deepEqual(offsets,[0,200]);
});
test('API invalid list cannot imply missing metadata',async()=>{
    globalThis.mockRequest=async()=>response({success:true,data:{}});
    await assert.rejects(listRemoteFiles(new SynologyClient('https://nas.test','user'),'/mydrive/test'));
});

test('third device joins after conflicting edits and all devices converge',async()=>{
    const r=new Remote();const a=device(r,{'folder/note.md':'initial'});await a.sync();const b=device(r);await b.sync();a.put('folder/note.md','A');b.put('folder/note.md','B');await a.sync();await b.sync();const c=device(r);await c.sync();await a.sync();for(const d of [a,b,c])await stable(d,r);assert.equal(a.read('folder/note.md'),b.read('folder/note.md'));assert.equal(b.read('folder/note.md'),c.read('folder/note.md'));
});
test('one hundred copied snapshots on empty device authorize zero deletions',async()=>{
    const r=new Remote();const initial=Object.fromEntries(Array.from({length:100},(_,i)=>[`${i}.md`,`note ${i}`]));const a=device(r,initial);await a.sync();const b=device(r,{},a.storage.get('plugin/sync_data.json'));await b.sync();assert.equal(b.contents.size,100);assert.equal(Object.values(r.manifest().files).filter(v=>v.deleted).length,0);
});
test('corrupted pending payload fails closed without publishing content',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});r.fail=(op,p)=>{if(op==='upload'&&p===root+'/a.md')throw Error('disconnect');};await assert.rejects(d.sync());r.fail=null;r.files.set(root+'/.sync_pending_data',bytes('corrupted'));await assert.rejects(d.sync());assert.equal(r.files.has(root+'/a.md'),false);assert.ok(r.files.has(root+'/.sync_pending.json'));
});
test('failure removing committed journal retries without increasing revision',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});r.fail=(op,p)=>{if(op==='delete'&&p.endsWith('.sync_pending.json'))throw Error('network');};await assert.rejects(d.sync());const rev=r.manifest().files['a.md'].rev;r.fail=null;await d.sync();assert.equal(r.manifest().files['a.md'].rev,rev);await stable(d,r);
});
test('existing conflicting recovery path is never overwritten',async()=>{
    const r=new Remote();await seed(r,'a.md','remote');const copy=`a (Conflict ${await hash(bytes('remote'))}).md`;const d=device(r,{'a.md':'local',[copy]:'different content'});await assert.rejects(d.sync());assert.equal(d.read(copy),'different content');assert.equal(text(r.files.get(root+'/a.md')),'remote');
});
test('another device cannot start during a held write and succeeds afterwards',async()=>{
    const r=new Remote();const a=device(r,{'a.md':'A'});const b=device(r);const m=new ManifestManager(r,root);await m.acquireLock('A');await assert.rejects(b.sync());await m.releaseLock('A');await a.sync();await b.sync();assert.equal(b.read('a.md'),'A');
});

test('text edit immediately before atomic replacement is preserved',async()=>{
    const r=new Remote();const a=device(r,{'a.md':'A'});await a.sync();const b=device(r);await b.sync();a.put('a.md','remote');await a.sync();
    const original=b.app.vault.process;b.app.vault.process=async(file,fn)=>{b.put(file.path,'latest typing');return original(file,fn);};
    await assert.rejects(b.engine().runSync(false));assert.equal(b.read('a.md'),'latest typing');
});

test('explicit Drive roots and ID-system folders are not prefixed twice',()=>{
    for(const path of ['/mydrive','/mydrive/','/team-folders/team','/views/123','/volumes/home/Drive','id:123','link:abc']) {
        assert.equal(normalizeRemoteFolder(path),path.replace(/\/$/,''));
        if (/^(id:|link:)/.test(path)) assert.throws(()=>remoteFilePath(path,'note.md'));
        else assert.equal(remoteFilePath(path,'note.md'),path.replace(/\/$/,'')+'/note.md');
    }
    assert.equal(normalizeRemoteFolder('/Notes'),'/mydrive/Notes');
    assert.equal(remoteFilePath('/mydrive','note.md'),'/mydrive/note.md');
});
test('legacy metadata contract returns null for code 1003',async()=>{
    globalThis.mockRequest=async()=>response({success:false,error:{code:1003}});
    assert.equal(await new SynologyClient('https://nas.test','user').getMetadata('/mydrive/note.md'),null);
});
test('list code 1003 reports the requested path without speculative retries',async()=>{
    let calls=0;globalThis.mockRequest=async()=>{calls++;return response({success:false,error:{code:1003}});};
    await assert.rejects(listRemoteFiles(new SynologyClient('https://nas.test','user'),'/mydrive/Notes'),/Notes.*1003/);
    assert.equal(calls,1);
});
test('v2 type dir entries recurse without downloading directories',async()=>{
    const r=new Remote();await seed(r,'folder/a.md','A');const original=r.listFiles.bind(r);
    r.listFiles=async path=>{const res=await original(path);return {success:true,data:{total:res.data.items.length,items:res.data.items.map(({isdir,...item})=>({...item,type:isdir?'dir':'file'}))}};};
    const d=device(r);await d.sync();assert.equal(d.read('folder/a.md'),'A');
});

test('documented total ends listing at an exact page boundary',async()=>{
    const offsets=[];globalThis.mockRequest=async req=>{
        const offset=Number(new URL(req.url).searchParams.get('offset'));offsets.push(offset);
        return response({success:true,data:{total:200,items:Array.from({length:200},(_,i)=>({name:String(i),type:'file'}))}});
    };
    const result=await new SynologyClient('https://nas.test','user').listFiles('/mydrive/Notes');
    assert.equal(result.data.items.length,200);assert.deepEqual(offsets,[0]);
});
test('sync boundary rejects a partial result without changing legacy API pagination',async()=>{
    globalThis.mockRequest=async()=>response({success:true,data:{total:3,items:[{name:'A',type:'file'}]}});
    await assert.rejects(listRemoteFiles(new SynologyClient('https://nas.test','user'),'/mydrive/Notes'));
});
test('sync boundary rejects an empty incomplete listing',async()=>{
    globalThis.mockRequest=async()=>response({success:true,data:{total:2,items:[]}});
    await assert.rejects(listRemoteFiles(new SynologyClient('https://nas.test','user'),'/mydrive/Notes'));
});
test('metadata request and fields match the repository API documentation example',async()=>{
    const fixture=JSON.parse(readFileSync(new URL('./fixtures/drive-v2-metadata.json',import.meta.url),'utf8'));
    let request;globalThis.mockRequest=async req=>{request=req;return response(fixture);};
    const result=await new SynologyClient('https://nas.test','user').getMetadata('/mydrive/123');
    const url=new URL(request.url);
    assert.equal(request.method,'GET');assert.equal(url.pathname,'/api/SynologyDrive/default/v2/files');
    assert.equal(url.searchParams.get('path'),'/mydrive/123');
    assert.equal(result.data.type,'dir');assert.equal(result.data.display_path,'/mydrive/123');
    assert.equal(result.data.modified_time,1728375733);assert.equal(result.data.version_id,'3028');
});
test('list request consumes the unmodified repository API documentation example',async()=>{
    const fixture=JSON.parse(readFileSync(new URL('./fixtures/drive-v2-list.json',import.meta.url),'utf8'));
    const requests=[];globalThis.mockRequest=async req=>{requests.push(req);return response(fixture);};
    const result=await new SynologyClient('https://nas.test','user').listFiles('/mydrive/123');
    assert.equal(requests.length,1);const request=requests[0];const url=new URL(request.url);
    assert.equal(request.method,'POST');assert.equal(url.pathname,'/api/SynologyDrive/default/v2/files/list');
    assert.equal(url.searchParams.get('path'),'/mydrive/123');assert.equal(url.searchParams.get('offset'),'0');
    assert.equal(url.searchParams.get('limit'),'200');assert.deepEqual(JSON.parse(request.body),{});
    assert.equal(result.data.total,2);assert.equal(result.data.items.length,2);
    assert.equal(result.data.items[0].type,'file');assert.equal(result.data.items[0].path,'/123/2.jpg');
});

test('existing manifest is read without a directory listing',async()=>{
    const r=new Remote();await seed(r,'a.md','A');r.listFiles=async()=>{throw Error('API Error Code: 1003');};
    const manager=new ManifestManager(r,root);assert.equal((await manager.downloadManifest()).files['a.md'].hash,await hash(bytes('A')));
});
test('exclusive lock acquisition no longer requires directory enumeration',async()=>{
    const r=new Remote();r.listFiles=async()=>{throw Error('API Error Code: 1003');};const manager=new ManifestManager(r,root);await manager.acquireLock('A');await manager.releaseLock('A');
});
test('failed optional-record read is not converted to an empty manifest',async()=>{
    const r=new Remote();r.listFiles=async()=>{throw Error('API Error Code: 1003');};
    await assert.rejects(readRemoteRecord(r,root+'/.sync_pending.json'),/\.sync_pending\.json.*1003/);
});

test('new nested upload creates its parent before the sync existence check',async()=>{
    const r=new Remote();const original=r.listFiles.bind(r);
    r.listFiles=async path=>{if(!r.folders.has(path))throw Error('API Error Code: 1003');return original(path);};
    const d=device(r,{'new/sub/a.md':'A'});await d.sync();assert.equal(text(r.files.get(root+'/new/sub/a.md')),'A');
});

test('HTTP 400 during lock creation names the operation and path once',async()=>{
    const r=new Remote();r.createFolder=async()=>{throw Error('HTTP 400: HTTP 400');};
    await assert.rejects(device(r).sync(),error=>{
        assert.match(error.message,/create sync lock/);assert.match(error.message,/\/mydrive\/test\/\.sync_lock/);
        assert.equal(error.message.match(/HTTP 400/g).length,1);return true;
    });
});
test('lock cleanup failure never masks the primary sync failure',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});await d.sync();d.put('a.md','B');
    r.fail=(operation,path)=>{
        if(operation==='upload'&&path===root+'/a.md')throw Error('primary upload failure');
        if(operation==='delete'&&path===root+'/.sync_lock')throw Error('HTTP 400: HTTP 400');
    };
    await assert.rejects(d.sync(),/primary upload failure/);
    assert.ok(d.logs.some(log=>log.details?.includes('primary upload failure')));
    assert.ok(d.logs.some(log=>log.details?.includes('HTTP 400')));
});
test('cleanup failure after successful sync is still reported',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});
    r.fail=(operation,path)=>{if(operation==='delete'&&path===root+'/.sync_lock')throw Error('HTTP 400: HTTP 400');};
    await assert.rejects(d.sync(),/delete remote entry.*\.sync_lock.*HTTP 400/);
});
test('diagnostics preserve API arguments and original failure without extra requests',async()=>{
    const r=new Remote();const calls=[];const originalError=Error('HTTP 400: HTTP 400');
    r.createFolder=async(...args)=>{calls.push(args);throw originalError;};
    await assert.rejects(withRemoteDiagnostics(r).createFolder(root+'/.sync_lock','stop'),error=>{assert.equal(error.originalError,originalError);return true;});
    assert.deepEqual(calls,[[root+'/.sync_lock','stop']]);
});

test('lock verification recovers from a bare HTTP 400 without recreating its owner',async()=>{
    const r=new Remote();const m=new ManifestManager(withRemoteDiagnostics(r),root);await m.acquireLock('A');
    const writes=r.writes.length;let reads=0;
    r.fail=(operation,path)=>{if(operation==='download'&&path===root+'/.sync_lock/owner.json'&&++reads<3)throw Error('HTTP 400: HTTP 400');};
    await m.assertLock();assert.equal(reads,3);assert.equal(r.writes.length,writes);
});
test('persistent lock read failure retains the lock and blocks publication',async()=>{
    const r=new Remote();const m=new ManifestManager(withRemoteDiagnostics(r),root);await m.acquireLock('A');
    const original=Error('HTTP 400');let reads=0;
    r.fail=(operation)=>{if(operation==='download'){reads++;throw original;}};
    await assert.rejects(m.uploadManifest({schemaVersion:1,files:{}},'A'),error=>error.originalError.originalError===original && /owner.json is listed/.test(error.message));
    assert.equal(reads,3);assert.equal(r.files.has(root+'/.sync_manifest.json'),false);assert.equal(r.folders.has(root+'/.sync_lock'),true);
});
test('ownership mismatch after a retry still blocks publication',async()=>{
    const r=new Remote();const m=new ManifestManager(r,root);await m.acquireLock('A');let reads=0;
    r.fail=(operation)=>{if(operation==='download'&&++reads===1){r.files.set(root+'/.sync_lock/owner.json',bytes('other'));throw Error('HTTP 400');}};
    await assert.rejects(m.uploadManifest({schemaVersion:1,files:{}},'A'));
    assert.equal(reads,2);assert.equal(r.files.has(root+'/.sync_manifest.json'),false);
});
test('authentication and specific API errors are not retried by lock verification',async()=>{
    for(const message of ['HTTP 401: API Error Code: 1002','HTTP 400: API Error Code: 1003']){
        const r=new Remote();const m=new ManifestManager(withRemoteDiagnostics(r),root);await m.acquireLock('A');let reads=0;
        r.fail=(operation)=>{if(operation==='download'){reads++;throw Error(message);}};
        await assert.rejects(m.assertLock());assert.equal(reads,1);
    }
});
test('mid-transaction lock read HTTP 400 resumes and commits the uploaded content',async()=>{
    const r=new Remote();const d=device(r,{'a.md':'A'});let pending=false;let failures=0;
    r.fail=(operation,path)=>{
        if(operation==='upload'&&path===root+'/.sync_pending_data')pending=true;
        if(pending&&operation==='download'&&path===root+'/.sync_lock/owner.json'&&failures===0){failures++;throw Error('HTTP 400');}
    };
    await d.sync();assert.equal(failures,1);assert.equal(text(r.files.get(root+'/a.md')),'A');
    assert.equal(r.manifest().files['a.md'].hash,await hash(bytes('A')));
    assert.equal(r.folders.has(root+'/.sync_lock'),false);assert.equal(r.files.has(root+'/.sync_pending.json'),false);
});
test('missing lock owner is reported without recreating any remote entry',async()=>{
    const r=new Remote();const original=Error('HTTP 400');
    const error=await diagnoseLockRead(r,root+'/.sync_lock/owner.json',original);
    assert.match(error.message,/owner.json is not listed/);assert.equal(error.originalError,original);assert.deepEqual(r.writes,[]);
});
test('failed lock listing reports unknown existence and retains both errors',async()=>{
    const r=new Remote();r.listFiles=async()=>{throw Error('API Error Code: 1003');};
    const error=await diagnoseLockRead(r,root+'/.sync_lock/owner.json',Error('HTTP 400'));
    assert.match(error.message,/HTTP 400/);assert.match(error.message,/unable to determine/);assert.match(error.message,/1003/);
});
test('partial lock listing cannot be reported as missing',async()=>{
    const r=new Remote();r.listFiles=async()=>({success:true,data:{total:1,items:[]}});
    const error=await diagnoseLockRead(r,root+'/.sync_lock/owner.json',Error('HTTP 400'));
    assert.match(error.message,/unable to determine/);
});
