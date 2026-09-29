import { readFile,writeFile,mkdir,rename,readdir,realpath } from 'node:fs/promises';
import { join,extname,resolve,relative } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID,createHash } from 'node:crypto';
import { analyzePublishEvidence,analyzeNewBusinessEvidence,enrichPublishSources,validateCopy,validateSohuArticle,sanitizePublishedCopy,publicationSnapshot,fingerprint,COMPANY,ACCOUNT,NEW_BUSINESS_CATEGORIES,redactForbiddenCompanyNames } from './publish-analysis.mjs';
import { generatePublishCopy,generateSohuArticle,generateSupplementalImages } from './publish-generator.mjs';
import { confirmedCaseReferences,confirmedCasesForCategory,isConfirmedCaseId } from './confirmed-case-library.mjs';
import { DouyinPublisher } from './douyin-publisher.mjs';
import { SohuPublisher } from './sohu-publisher.mjs';
import { initialMusicRotation,rotatePhotoCandidates } from './publish-rotation.mjs';
import { extractCompanyNames,nameKey } from './competitor-model.mjs';

const stamp=()=>new Date().toISOString(),fail=(message,status=400)=>Object.assign(new Error(message),{status}),attention=message=>Object.assign(new Error(message),{code:'NEEDS_ATTENTION'});
const frozen=new Set(['submitting','submitted','published','uncertain','rejected']),active=new Set(['generating','generating_images','preparing','submitting']);
const platformOf=value=>value==='sohu'?'sohu':'douyin';

export function validateSelection(draft,assets){
  if(!Array.isArray(draft.imageIds)||draft.imageIds.length<1||draft.imageIds.length>9||new Set(draft.imageIds).size!==draft.imageIds.length)throw fail('请选择 1–9 张不重复图片。');
  const selected=draft.imageIds.map(id=>assets.find(a=>a.id===id));
  if(selected.some(a=>!a||(a.origin==='generated'&&!a.approvedAt)))throw fail('存在未确认或不可用的图片。');
  if(selected.filter(a=>a.origin==='folder').length<=selected.length/2)throw fail('每条必须包含文件夹原图，且原图应占多数。');
}
export function validateSohuSelection(draft,assets,previous=[]){
  if(!Array.isArray(draft.imageIds)||draft.imageIds.length<1||draft.imageIds.length>2||new Set(draft.imageIds).size!==draft.imageIds.length)throw fail('搜狐文章请选择 1–2 张不重复的相关照片。');
  if(draft.imageIds.map(id=>assets.find(a=>a.id===id)).some(a=>!a||a.origin!=='folder'))throw fail('搜狐文章只使用照片选择文件夹中的原图。');
  if(draft.imageIds.some(id=>previous.includes(id)))throw fail('上一篇搜狐文章使用过的照片，不能紧接着再用。');
}

export async function createPublishService({root,getSource,photoDir=join(homedir(),'Desktop','照片选择'),generator=generatePublishCopy,sohuGenerator=generateSohuArticle,imageGenerator=generateSupplementalImages,publisher=null,douyinPublisher=publisher||new DouyinPublisher({root}),sohuPublisher=new SohuPublisher({root}),readSources=enrichPublishSources}){
  const directory=join(root,'data','publishing'),mediaDir=join(directory,'media'),dbPath=join(directory,'publishing.json');await mkdir(mediaDir,{recursive:true});
  let db;
  try{const old=JSON.parse(await readFile(dbPath,'utf8'));if(old.version===1&&Array.isArray(old.drafts))db={version:2,draftsByPlatform:{douyin:old.drafts.map(d=>({...d,platform:'douyin',contentType:d.contentType||'plush_factory'})),sohu:[]},assets:old.assets||[],musicRotation:old.musicRotation};else if(old.version===2&&Array.isArray(old.draftsByPlatform?.douyin)&&Array.isArray(old.draftsByPlatform?.sohu))db=old;else throw fail('发布数据格式异常，请检查备份。');}catch(error){if(error.code!=='ENOENT')throw error;db={version:2,draftsByPlatform:{douyin:[],sohu:[]},assets:[]};}
  const allDrafts=()=>[...db.draftsByPlatform.douyin,...db.draftsByPlatform.sohu].sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0));
  if(!db.musicRotation||!Array.isArray(db.musicRotation.usedKeys))db.musicRotation=initialMusicRotation(db.draftsByPlatform.douyin);
  let tail=Promise.resolve(),busy=false;
  const persist=()=>{const snapshot=JSON.stringify(db),job=tail.then(async()=>{await writeFile(dbPath+'.tmp',snapshot,'utf8');await rename(dbPath+'.tmp',dbPath);});tail=job.catch(()=>{});return job;};
  for(const d of allDrafts()){d.platform=platformOf(d.platform);d.contentType=d.contentType||(d.platform==='sohu'?'new_business':'plush_factory');Object.assign(d,sanitizePublishedCopy(d));d.douyinTitle=String(d.douyinTitle||'');d.tags=Array.isArray(d.tags)?d.tags:[];d.imageAfterParagraphs=Array.isArray(d.imageAfterParagraphs)?d.imageAfterParagraphs:(d.imageIds||[]).map((_,i)=>i?2:0);if(d.platform==='douyin'&&!frozen.has(d.status)){d.declaration={label:'无需添加自主声明',verified:false};d.topics={tags:d.tags,verified:false};}}
  for(const d of allDrafts())if(active.has(d.status)||d.status==='ready'){d.status=d.submitIntent?'uncertain':'interrupted';d.preparedAt=null;if(d.music)d.music.verified=false;if(d.location)d.location.verified=false;if(d.declaration)d.declaration.verified=false;if(d.sohuForm)d.sohuForm.verified=false;d.message=d.submitIntent?'上次提交中服务中断，请核查平台结果，不会自动重发。':'服务已重启，请重新准备发布表单；已生成内容保留。';}
  await persist();
  const mediaPath=a=>join(mediaDir,a.filename),assetPublic=({filename,...a})=>({...a,url:`/api/publisher/media/${a.id}`}),draftPublic=d=>({...d,approvalHash:fingerprint(publicationSnapshot(d,db.assets))});
  const previousSohuImages=(exclude=null)=>db.draftsByPlatform.sohu.find(d=>d.id!==exclude&&!['failed','rejected'].includes(d.status)&&d.imageIds?.length)?.imageIds||[];
  const eligibleCases=d=>confirmedCasesForCategory(d.businessCategory||'',{limit:2});
  const checkCaseIds=(d,caseIds=[])=>{
    const chosen=[...new Set(Array.isArray(caseIds)?caseIds:[])];
    if(chosen.length>2)throw fail('一篇搜狐文章最多使用两个真实案例。');
    const allowed=new Set(eligibleCases(d).map(item=>item.id));
    const unknown=chosen.find(id=>!isConfirmedCaseId(id)||!allowed.has(id));
    if(unknown)throw fail(`当前业务不能使用该真实案例：${unknown}`);
    return chosen;
  };
  const recommendation=platform=>{try{return analyzeNewBusinessEvidence(getSource(),db.draftsByPlatform[platform],{platform});}catch(error){return{error:error.message,focus:null,categoryStats:[],latestRuns:[]};}};
  const publicAssets=platform=>rotatePhotoCandidates(db.assets,db.draftsByPlatform[platform],{limit:db.assets.length,random:()=>0.5}).map(assetPublic);
  const list=()=>({draftsByPlatform:{douyin:db.draftsByPlatform.douyin.map(draftPublic),sohu:db.draftsByPlatform.sohu.map(draftPublic)},drafts:db.draftsByPlatform.douyin.map(draftPublic),assetsByPlatform:{douyin:publicAssets('douyin'),sohu:publicAssets('sohu')},assets:publicAssets('douyin'),busy,accountId:ACCOUNT,company:COMPANY,photoDir,categories:NEW_BUSINESS_CATEGORIES,recommendations:{douyin:recommendation('douyin'),sohu:recommendation('sohu')}});
  const get=id=>{const d=allDrafts().find(item=>item.id===id);if(!d)throw fail('草稿不存在',404);return d;},mutable=d=>{if(frozen.has(d.status))throw fail('这条内容已经提交或待核查，不能修改或重复发布。',409);if(busy||active.has(d.status))throw fail('当前任务处理中，请稍候。',409);},checkRevision=(d,input)=>{if(input.revision!==d.revision)throw fail('草稿已经更新，请刷新总览后重试。',409);};
  async function addAsset(file,origin,name,extra={}){const bytes=await readFile(file);if(bytes.length>30*1024*1024)throw fail('图片超过 30MB，请先缩小图片。');const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=bytes[0]===255&&bytes[1]===216;if(!png&&!jpg)throw fail('目前支持 PNG 和 JPG 原图。');const hash=createHash('sha256').update(bytes).digest('hex'),id=origin+'-'+hash.slice(0,24),existing=db.assets.find(a=>a.id===id);if(existing)return existing;const filename=id+(png?'.png':'.jpg');await writeFile(join(mediaDir,filename),bytes,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});const asset={id,hash,filename,name,origin,createdAt:stamp(),...extra};db.assets.push(asset);return asset;}
  async function importPhotos(){const names=await readdir(photoDir,{withFileTypes:true}).catch(()=>{throw fail('无法读取照片选择文件夹，请检查路径。');}),available=[];for(const entry of names)if(entry.isFile()&&/\.(png|jpe?g)$/i.test(entry.name))available.push(await addAsset(join(photoDir,entry.name),'folder',entry.name));if(!available.length)throw fail('照片文件夹没有可用原图。');await persist();return available;}
  function background(draft,fn){busy=true;void(async()=>{try{await fn();}catch(error){draft.status=draft.submitIntent?'uncertain':error.code==='NEEDS_ATTENTION'?'needs_attention':'failed';draft.message=error.message.split(/\nBrowser logs:|\nCall log:/)[0].slice(0,350);draft.updatedAt=stamp();}finally{try{await persist();}finally{busy=false;}}})().catch(()=>{busy=false;});}
  const publisherFor=d=>d.platform==='sohu'?sohuPublisher:douyinPublisher,validateMedia=d=>d.platform==='sohu'?validateSohuSelection(d,db.assets,previousSohuImages(d.id)):validateSelection(d,db.assets);
  async function prepare(d){
    Object.assign(d,d.platform==='sohu'?validateSohuArticle(d):validateCopy(d));validateMedia(d);const target=publisherFor(d),assets=db.assets.map(a=>({...a,path:mediaPath(a)}));
    const prepared=await target.prepare(d.platform==='douyin'?{...d,musicRotation:{cycle:Number(db.musicRotation.cycle||1),usedKeys:[...db.musicRotation.usedKeys]}}:d,assets);
    if(d.platform==='douyin'){
      if(!prepared.music?.verified)throw attention('背景音乐未在抖音表单完成核对。');if(!prepared.location?.verified||prepared.location.name!==COMPANY)throw attention('公司位置未完成核对。');if(!prepared.declaration?.verified||prepared.declaration.label!=='无需添加自主声明')throw attention('自主声明必须选择“无需添加自主声明”。');if(!prepared.topics?.verified||JSON.stringify(prepared.topics.tags)!==JSON.stringify(d.tags))throw attention('话题标签未逐个选中。');
      if(prepared.music?.rotationKey){if(prepared.music.rotationCycleRestarted){db.musicRotation.cycle=Number(db.musicRotation.cycle||1)+1;db.musicRotation.usedKeys=[];}if(!db.musicRotation.usedKeys.includes(prepared.music.rotationKey))db.musicRotation.usedKeys.push(prepared.music.rotationKey);db.musicRotation.lastSelectedKey=prepared.music.rotationKey;db.musicRotation.updatedAt=stamp();}
    }else if(!prepared.sohuForm?.verified)throw attention('搜狐文章表单未完成核对。');
    Object.assign(d,prepared,{status:'ready',message:d.platform==='sohu'?'搜狐文章总览与发布表单已核对，检查后可一键发布。':'总览与抖音表单已核对，检查后可一键发布。',updatedAt:stamp()});
  }
  async function makeImages(d){const result=await imageGenerator({root,prompts:d.imagePrompts,onProgress:m=>{d.message=m;}});if(!result.paths?.length)throw fail(result.error||'生图工具未返回图片。');const allowed=await realpath(join(homedir(),'.codex','generated_images')),pending=[];for(const file of result.paths.slice(0,2)){const actual=await realpath(file),rel=relative(allowed,actual);if(rel.startsWith('..')||resolve(allowed,rel)!==actual)throw fail('生图工具返回位置异常。');const a=await addAsset(actual,'generated','AI 示意图',{draftId:d.id,prompt:d.imagePrompts[pending.length]||'',approvedAt:null});pending.push(a.id);}d.pendingImageIds=pending;d.status='image_review';d.message='补充图片已生成，请先确认。';}
  return{list,importPhotos,publisher:douyinPublisher,douyinPublisher,sohuPublisher,async handle(req,res,url,bodyOf,json){
    if(!url.pathname.startsWith('/api/publisher'))return false;
    try{
      const suffix=url.pathname.slice('/api/publisher'.length),queryPlatform=platformOf(url.searchParams.get('platform'));
      if(req.method==='GET'&&suffix.startsWith('/media/')){const a=db.assets.find(x=>x.id===suffix.slice(7));if(!a)throw fail('图片不存在',404);const bytes=await readFile(mediaPath(a));res.writeHead(200,{'content-type':extname(a.filename)==='.png'?'image/png':'image/jpeg','cache-control':'private, max-age=31536000, immutable','x-content-type-options':'nosniff'});res.end(bytes);return true;}
      if(req.method==='GET'&&suffix===''){await tail;json(res,200,list());return true;}if(req.method==='GET'&&suffix==='/connection'){json(res,200,await(queryPlatform==='sohu'?sohuPublisher:douyinPublisher).status());return true;}if(req.method!=='POST')throw fail('接口不存在',404);
      if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)throw fail('发布请求来源无效',403);if(!String(req.headers['content-type']).startsWith('application/json'))throw fail('请使用发布页面操作',415);const input=await bodyOf(req),platform=platformOf(input.platform||queryPlatform);
      if(suffix==='/connect'){if(busy)throw fail('当前任务处理中',409);json(res,200,await(platform==='sohu'?sohuPublisher:douyinPublisher).connect());return true;}if(suffix==='/photos/refresh'){if(busy)throw fail('当前任务处理中',409);await importPhotos();json(res,200,list());return true;}
      if(suffix==='/manual-sohu-draft'){
        if(busy)throw fail('已有任务正在处理中。',409);
        await importPhotos();
        const article=validateSohuArticle(input);
        const imageIds=[...new Set(Array.isArray(input.imageIds)?input.imageIds:[])].slice(0,2);
        const d={id:randomUUID(),platform:'sohu',contentType:'plush_factory',sohuMode:'manual',businessCategory:null,topicPromptId:null,topicPromptKey:null,revision:1,status:'draft',createdAt:stamp(),updatedAt:stamp(),...article,caseIds:[],caseReferences:[],imageIds,imageAfterParagraphs:Array.isArray(input.imageAfterParagraphs)?input.imageAfterParagraphs:[],pendingImageIds:[],imagePrompts:[],music:null,location:{name:COMPANY,verified:false},accountId:null,analysis:{kind:'manual',forbiddenCompanyNames:[]},message:'已载入指定搜狐文章，请审阅后准备发布。'};
        validateSohuSelection(d,db.assets,previousSohuImages(d.id));
        db.draftsByPlatform.sohu.unshift(d);await persist();json(res,201,draftPublic(d));return true;
      }
      if(suffix==='/generate'){
        if(busy)throw fail('已有任务正在处理中。',409);busy=true;let candidates;try{candidates=await importPhotos();}catch(error){busy=false;throw error;}
        const contentType=platform==='sohu'?'new_business':input.contentType==='new_business'?'new_business':'plush_factory',sohuMode=input.sohuMode==='independent'?'independent':'citation_reference',category=input.businessCategory&&input.businessCategory!=='auto'?String(input.businessCategory):null;
        if(platform==='sohu'){const blocked=new Set(previousSohuImages());candidates=rotatePhotoCandidates(candidates.filter(a=>!blocked.has(a.id)),db.draftsByPlatform.sohu,{limit:12});}else candidates=rotatePhotoCandidates(candidates,db.draftsByPlatform.douyin,{limit:contentType==='new_business'?12:7});if(!candidates.length){busy=false;throw fail(platform==='sohu'?'可用照片都与上一篇重复，请补充新照片。':'没有可用照片。');}
        const d={id:randomUUID(),platform,contentType,sohuMode:platform==='sohu'?sohuMode:null,businessCategory:category,topicPromptId:null,topicPromptKey:null,revision:1,status:'generating',createdAt:stamp(),updatedAt:stamp(),title:'',douyinTitle:'',body:'',tags:[],topics:{tags:[],verified:false},imageIds:[],imageAfterParagraphs:[],pendingImageIds:[],imagePrompts:[],music:null,location:{name:COMPANY,verified:false},accountId:platform==='douyin'?ACCOUNT:null,message:contentType==='new_business'?'正在分析最近 5 次新题库测试':'正在分析最近 10 天测试'};db.draftsByPlatform[platform].unshift(d);await persist();
        background(d,async()=>{
          if(contentType==='new_business')d.analysis=analyzeNewBusinessEvidence(getSource(),db.draftsByPlatform[platform].slice(1),{categoryId:category,platform});else{const roster=JSON.parse(await readFile(join(root,'data','competitors.json'),'utf8'));d.analysis=analyzePublishEvidence(getSource(),roster,db.draftsByPlatform.douyin.slice(1));}
          d.businessCategory=d.analysis.focus?.id||d.businessCategory;d.topicPromptId=d.analysis.topicPromptId||null;d.topicPromptKey=d.analysis.topicPromptKey||null;await persist();if(platform==='douyin'||sohuMode==='citation_reference')await readSources(d.analysis);if(platform==='sohu'){const evidence=[...(d.analysis.examples||[]).map(item=>item.answer),...(d.analysis.sources||[]).map(item=>`${item.title||''}\n${item.excerpt||''}`)].join('\n');d.analysis.forbiddenCompanyNames=extractCompanyNames(evidence).filter(name=>nameKey(name)!==nameKey(COMPANY)&&nameKey(name)!==nameKey('目标品牌'));}d.message=platform==='sohu'?'正在生成搜狐文章并核对照片':'正在生成抖音文案并核对原图';await persist();
          const source=getSource(),approvedKnowledge=(source.knowledge||[]).filter(item=>item.status==='approved'),approvedCases=platform==='sohu'?eligibleCases(d):[],args={root,analysis:d.analysis,candidates:candidates.map(a=>({...a,path:mediaPath(a)})),history:db.draftsByPlatform[platform].slice(1),approvedKnowledge,approvedCases,onProgress:m=>{d.message=m;}},copy=platform==='sohu'?await sohuGenerator({...args,mode:sohuMode,userInput:String(input.userInput||'').slice(0,20000)}):await generator({...args,contentType});
          if(platform==='sohu'){
            copy.forbiddenCompanyNames=d.analysis.forbiddenCompanyNames;
            const article=validateSohuArticle(copy),caseIds=checkCaseIds(d,article.caseIds);
            Object.assign(d,article,{caseIds,caseReferences:confirmedCaseReferences(caseIds)});
          }else Object.assign(d,validateCopy(copy));
          d.imageIds=[...new Set(copy.imageIds||[])].filter(id=>candidates.some(a=>a.id===id)).slice(0,platform==='sohu'?2:6);d.imageAfterParagraphs=platform==='sohu'?d.imageIds.map((_,i)=>Number(copy.imageAfterParagraphs?.[i]??(i?2:0))):[];
          if(!d.imageIds.length)throw attention(platform==='sohu'?'照片库没有与文章明显相关的照片，请添加相关原图。':'没有选出有效原图。');if(platform==='sohu')validateSohuSelection(d,db.assets,previousSohuImages(d.id));d.imagePrompts=platform==='douyin'?(copy.imagePrompts||[]).filter(x=>typeof x==='string').slice(0,2):[];d.rationale=platform==='sohu'?redactForbiddenCompanyNames(String(copy.rationale||''),d.analysis?.forbiddenCompanyNames):String(copy.rationale||'');d.sourcePatterns=(copy.sourcePatterns||[]).map(value=>platform==='sohu'?redactForbiddenCompanyNames(String(value),d.analysis?.forbiddenCompanyNames):String(value)).slice(0,3);
          if(platform==='douyin'&&d.imagePrompts.length){d.status='generating_images';d.message='正在生成补充图片';await persist();await makeImages(d);}else{d.status='draft';d.message=platform==='sohu'?'搜狐草稿已生成，请审阅后准备发布。':'抖音草稿已生成，正在准备发布表单。';await persist();if(platform==='douyin')await prepare(d);}
        });json(res,202,draftPublic(d));return true;
      }
      const match=suffix.match(/^\/drafts\/([^/]+)(?:\/(\w[\w-]*))?$/);if(!match)throw fail('接口不存在',404);const d=get(match[1]),action=match[2]||'save';
      if(action==='reconcile'){if(busy||!frozen.has(d.status)||d.status==='submitting')throw fail('当前无法核查',409);busy=true;try{Object.assign(d,await publisherFor(d).reconcile(d),{updatedAt:stamp()});await persist();}finally{busy=false;}json(res,200,draftPublic(d));return true;}
      mutable(d);checkRevision(d,input);
      if(action==='save'){
        if(d.platform==='sohu'){const copy=validateSohuArticle({...input,caseIds:Array.isArray(input.caseIds)?input.caseIds:d.caseIds,forbiddenCompanyNames:d.analysis?.forbiddenCompanyNames}),caseIds=checkCaseIds(d,copy.caseIds),next={...d,...copy,caseIds,caseReferences:confirmedCaseReferences(caseIds),imageIds:input.imageIds,imageAfterParagraphs:Array.isArray(input.imageAfterParagraphs)?input.imageAfterParagraphs:[]};validateSohuSelection(next,db.assets,previousSohuImages(d.id));Object.assign(d,next,{sohuForm:{verified:false}});}else{const copy=validateCopy(input),musicTitle=String(input.musicTitle||'').slice(0,100),next={...d,...copy,imageIds:input.imageIds,music:musicTitle?{title:musicTitle,verified:false,userChosen:!!d.music?.userChosen||musicTitle!==d.music?.title}:null};validateSelection(next,db.assets);if(next.music)next.music.verified=false;if(next.location)next.location.verified=false;if(next.declaration)next.declaration.verified=false;next.topics={tags:next.tags,verified:false};Object.assign(d,next);}
        Object.assign(d,{revision:d.revision+1,status:'draft',preparedAt:null,message:d.platform==='sohu'?'修改已保存，请重新准备搜狐表单。':'修改已保存，请重新准备抖音表单。',updatedAt:stamp()});await persist();json(res,200,draftPublic(d));return true;
      }
      if(action==='images-approve'){if(d.platform!=='douyin')throw fail('搜狐不使用AI补充图。');const ids=(input.imageIds||[]).filter(id=>d.pendingImageIds.includes(id));if(ids.length!==input.imageIds?.length)throw fail('图片确认无效');const selected=[...new Set([...d.imageIds,...ids])];if(selected.filter(id=>db.assets.find(a=>a.id===id)?.origin==='folder').length<=selected.length/2)throw fail('请确保原图占多数。');ids.forEach(id=>{db.assets.find(a=>a.id===id).approvedAt=stamp();});d.imageIds=selected;d.pendingImageIds=[];d.revision++;d.status='draft';d.preparedAt=null;d.topics={tags:d.tags,verified:false};d.message='图片审阅已完成。';await persist();json(res,200,draftPublic(d));return true;}
      if(action==='images-generate'){if(d.platform!=='douyin'||!d.imagePrompts.length)throw fail('本次无需补充图片。');d.status='generating_images';background(d,()=>makeImages(d));await persist();json(res,202,draftPublic(d));return true;}
      if(action==='prepare'){if(d.pendingImageIds.length)throw fail('请先审阅补充图片');d.status='preparing';d.message=d.platform==='sohu'?'正在填写搜狐文章、封面和正文插图':'正在核对账号、图片、音乐和位置';background(d,()=>prepare(d));await persist();json(res,202,draftPublic(d));return true;}
      if(action==='publish'){
        if(d.status!=='ready'||!d.preparedAt||d.pendingImageIds.length)throw fail('请完成内容审阅及发布表单准备。',409);if(d.platform==='douyin'&&(!d.topics?.verified||JSON.stringify(d.topics.tags)!==JSON.stringify(d.tags)||d.declaration?.label!=='无需添加自主声明'||!d.declaration.verified))throw fail('请重新准备抖音表单。',409);if(d.platform==='sohu'&&!d.sohuForm?.verified)throw fail('请重新准备搜狐表单。',409);d.platform==='sohu'?validateSohuArticle(d):validateCopy(d);validateMedia(d);if(input.approvalHash!==fingerprint(publicationSnapshot(d,db.assets)))throw fail('总览已变化，请重新检查。',409);d.status='submitting';d.message=`正在提交${d.platform==='sohu'?'搜狐文章':'抖音图文'}`;background(d,async()=>{const result=await publisherFor(d).submit(d,async()=>{d.submitIntent={at:stamp(),revision:d.revision,snapshot:publicationSnapshot(d,db.assets)};await persist();});Object.assign(d,result,{updatedAt:stamp()});if(result.status==='published')d.publishedAt=stamp();});await persist();json(res,202,draftPublic(d));return true;
        if(d.status!=='ready'||!d.preparedAt||d.pendingImageIds.length)throw fail('请完成内容审阅及发布表单准备。',409);if(d.platform==='douyin'&&(!d.topics?.verified||JSON.stringify(d.topics.tags)!==JSON.stringify(d.tags)||d.declaration?.label!=='无需添加自主声明'||!d.declaration.verified))throw fail('请重新准备抖音表单。',409);if(d.platform==='sohu'&&!d.sohuForm?.verified)throw fail('请重新准备搜狐表单。',409);const sanitized=d.platform==='sohu'?validateSohuArticle(d):validateCopy(d),changed=sanitized.title!==d.title||sanitized.body!==d.body||JSON.stringify(sanitized.tags)!==JSON.stringify(d.tags)||(d.platform==='douyin'&&sanitized.douyinTitle!==d.douyinTitle);if(changed)throw fail('文案中出现禁止的特殊符号，请重新准备发布表单。',409);validateMedia(d);if(input.approvalHash!==fingerprint(publicationSnapshot(d,db.assets)))throw fail('总览已变化，请重新检查。',409);d.status='submitting';d.message=`正在提交${d.platform==='sohu'?'搜狐文章':'抖音图文'}`;background(d,async()=>{const result=await publisherFor(d).submit(d,async()=>{d.submitIntent={at:stamp(),revision:d.revision,snapshot:publicationSnapshot(d,db.assets)};await persist();});Object.assign(d,result,{updatedAt:stamp()});if(result.status==='published')d.publishedAt=stamp();});await persist();json(res,202,draftPublic(d));return true;
      }
      throw fail('操作不存在',404);
    }catch(error){json(res,error.status||500,{error:error.message});return true;}
  }};
}
