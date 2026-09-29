import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCOUNT, COMPANY, fingerprint } from './publish-analysis.mjs';
import { chooseRotatingMusic, musicRotationKey } from './publish-rotation.mjs';

const HOME = 'https://creator.douyin.com/creator-micro/home';
const CREATOR_ORIGIN = 'https://creator.douyin.com';
const attention = message => Object.assign(new Error(message), { code:'NEEDS_ATTENTION' });
const publicIdentifier = draft => String(draft.douyinTitle || draft.body || '').split(/\r?\n/).find(Boolean)?.trim() || '';

export class DouyinPublisher {
  constructor({root}) { this.root=root; this.context=null; this.page=null; this.prepared=null; this.connecting=null; }
  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  async open() {
    if (!this.context) {
      const profile=join(this.root,'data','publishing','douyin-chromium-profile');
      await mkdir(profile,{recursive:true});
      try { this.context=await chromium.launchPersistentContext(profile,{headless:false,viewport:null,args:['--start-maximized']}); }
      catch {throw attention('发布浏览器未能启动，请关闭重复的发布专用窗口后重试。');}
      this.context.on('close',()=>{this.context=null;this.page=null;this.prepared=null;});
    }
    // The user requires the first Chrome permission choice for this exact site.
    // Re-apply it for every publishing session so the location prompt cannot block the form.
    await this.context.grantPermissions(['geolocation'],{origin:CREATOR_ORIGIN});
    this.page=this.context.pages().find(p=>p.url().includes('creator.douyin.com')) || await this.context.newPage();
    if (!this.page.url().includes('creator.douyin.com')) await this.page.goto(HOME,{waitUntil:'domcontentloaded'});
    await this.page.getByText(/抖音号|扫码登录/).first().waitFor({timeout:10000}).catch(()=>{});
    await this.page.bringToFront();
    return this.status();
  }
  async status() {
    if (!this.page || this.page.isClosed()) return {connected:false,ready:false,message:'请连接抖音发布窗口'};
    const text=await this.page.locator('body').innerText();
    const accountId=text.match(/抖音号[：:\s]*([\w-]+)/)?.[1] || null;
    const login=/扫码登录|验证码登录|登录抖音|立即登录/.test(text) && !accountId;
    const ready=accountId===ACCOUNT || (!!this.verifiedAccount && !login);
    return {connected:true,ready,accountId:accountId || this.verifiedAccount || null,
      message:login?'请在发布窗口手动登录你的抖音账号':accountId && accountId!==ACCOUNT?'当前账号与指定的发布账号不一致':ready?'已连接指定抖音账号':'发布窗口已打开，等待账号核对'};
  }
  async visible(locator) {
    const items=await locator.all(); const shown=[];
    for (const item of items) if(await item.isVisible()) shown.push(item);
    return shown;
  }
  async one(locator, message) {
    const list=await this.visible(locator);
    if(list.length!==1) throw attention(message);
    return list[0];
  }
  async clickText(text, message) {
    const locator=await this.one(this.page.getByText(text,{exact:true}),message || `发布页面中无法唯一确认“${text}”按钮`);
    await locator.click();
  }
  async assertPublic() {
    const texts=await this.visible(this.page.getByText('公开',{exact:true}));
    const labels=[];
    for(const text of texts) {
      const label=text.locator('xpath=ancestor-or-self::label[1]');
      if(await label.count()===1 && await label.isVisible()) labels.push(label);
    }
    if(labels.length!==1) throw attention('无法确认公开可见设置，请在发布窗口检查。');
    const label=labels[0],input=label.locator('input[type=radio],input[type=checkbox]').first();
    const selected=(await label.getAttribute('data-checked'))==='true' || (await label.getAttribute('aria-checked'))==='true' || (await input.count()===1 && await input.isChecked());
    if(!selected) throw attention('公开可见设置需要检查。');
  }
  async checkChallenge() {
    const text=await this.page.locator('body').innerText();
    if (/拖动滑块|请完成验证|安全验证|扫码登录|验证码登录/.test(text)) throw attention('抖音需要登录或人工验证，请在发布窗口完成后重新准备。');
  }
  async assertLocationPermission() {
    const state=await this.page.evaluate(()=>navigator.permissions?.query({name:'geolocation'}).then(result=>result.state).catch(()=>'unknown'));
    if(state!=='granted') throw attention('抖音位置权限未处于“访问该网站时允许”，请重新连接发布窗口。');
  }
  async verifyAccount() {
    // Verify against a separate home tab, without losing a composed post.
    const check=await this.context.newPage();
    try {
      await check.goto(HOME,{waitUntil:'domcontentloaded',timeout:30000});
      await check.getByText(/抖音号/).first().waitFor({timeout:15000}).catch(()=>{});
      const text=await check.locator('body').innerText();
      const actual=text.match(/抖音号[：:\s]*([\w-]+)/)?.[1];
      if(actual!==ACCOUNT) throw attention(actual ? `当前登录账号为 ${actual}，请切换到 ${ACCOUNT}` : '请在抖音发布窗口扫码登录指定账号，再点击重新准备。');
      this.verifiedAccount=actual;
    } finally { await check.close(); }
  }
  async prepare(draft, assets) {
    const step=label=>{this.currentStep=label;};
    try {
    step('连接发布窗口并核对账号');
    await this.connect(); await this.verifyAccount(); this.prepared=null;
    step('打开图文发布入口');
    await this.page.goto(HOME,{waitUntil:'domcontentloaded'});
    await this.assertLocationPermission();
    await this.page.getByText('发布图文',{exact:true}).first().waitFor({timeout:15000});
    await this.clickText('发布图文');
    await this.page.locator('input[type=file]').first().waitFor({state:'attached',timeout:15000});
    await this.checkChallenge();
    const fileInputs=await this.page.locator('input[type=file]').all();
    const imageInputs=[];
    for(const input of fileInputs) if(/image|png|jpg|jpeg/i.test(await input.getAttribute('accept') || '')) imageInputs.push(input);
    if(imageInputs.length!==1) throw attention('无法确认图文图片上传入口，请在发布窗口检查当前页面。');
    step('上传并等待图片处理');
    await imageInputs[0].setInputFiles(draft.imageIds.map(id=>assets.find(a=>a.id===id).path));
    await this.page.getByPlaceholder('添加作品标题',{exact:true}).waitFor({timeout:30000});
    const title=await this.one(this.page.getByPlaceholder(/填写作品标题|添加作品标题|标题/),'请检查图文标题输入框');
    step(draft.douyinTitle ? '填写抖音标题和正文' : '填写正文');
    await title.fill(draft.douyinTitle || '');
    const body=await this.one(this.page.locator('[contenteditable=true]'),'请检查图文正文输入框');
    await body.fill(draft.body);
    step('逐个选择抖音话题标签');
    const topics=await this.selectTopics(body,draft.tags);
    await title.click();
    await this.page.getByText(`已添加${draft.imageIds.length}张图片`,{exact:false}).first().waitFor({timeout:120000});
    await this.page.locator('[class^="img-Sb1Kaq"] img').first().waitFor({timeout:30000});
    step('选择公司位置');
    const location=await this.selectLocation();
    step('选择背景音乐');
    const music=await this.selectMusic(draft.music?.title || null,{...draft.musicRotation,userChosen:Boolean(draft.music?.userChosen)});
    step('设置无需添加自主声明');
    const declaration=await this.selectDeclaration();
    step('核对公开范围和全部表单内容');
    await this.checkChallenge();
    // Public state is required and is checked again immediately before submit.
    const text=await this.page.locator('body').innerText();
    await this.assertPublic();
    const snapshot={douyinTitle:draft.douyinTitle || '',body:draft.body,tags:draft.tags,imageIds:[...draft.imageIds],music,location,accountId:ACCOUNT};
    const proof=await this.formProof(snapshot);
    this.prepared={id:draft.id,revision:draft.revision,snapshot,proof};
    return {music,location,declaration,topics,accountId:ACCOUNT,preparedAt:new Date().toISOString()};
    } catch(error) {
      if(error.code!=='NEEDS_ATTENTION') error.message=`${this.currentStep}时失败：${error.message.split(/\nCall log:|\nBrowser logs:/)[0]}`;
      throw error;
    } finally { this.currentStep=null; }
  }
  async selectLocation() {
    const field=this.page.locator('[class^="anchor-component-"] .semi-select-selection-text');
    const existing=await this.visible(field.filter({hasText:COMPANY}));
    if(existing.length===1) return {name:COMPANY,verified:true};
    const trigger=await this.one(this.page.getByText('输入相关位置，让更多人看到你的作品',{exact:true}),'抖音页面未找到位置入口，请在发布窗口选择公司位置');
    await trigger.click();
    const search=await this.one(this.page.locator('[class^="anchor-component-"] input'),'无法确认位置搜索框');
    await search.fill(COMPANY);
    const choice=this.page.getByText(COMPANY,{exact:true});
    await choice.first().waitFor({timeout:20000}).catch(()=>{});
    await (await this.one(choice,'未找到唯一匹配的公司位置，请手动选择准确公司位置')).click();
    await field.filter({hasText:COMPANY}).waitFor({timeout:10000});
    return {name:COMPANY,verified:true};
  }
  async selectTopics(editor, tags) {
    const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    await editor.press('End');
    await editor.press('Enter');
    const selected=[];
    for(const tag of tags) {
      await editor.pressSequentially(`#${tag}`,{delay:35});
      const matches=this.page.getByText(new RegExp(`^#?\\s*${escape(tag)}$`));
      await this.page.waitForFunction(tag=>{
        const normalized=value=>String(value||'').replace(/\s+/g,'').replace(/^#/,'');
        return [...document.querySelectorAll('body *')].some(element=>{
          const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
          if(element.closest('[contenteditable=true]')||rect.width<=0||rect.height<=0||style.display==='none'||style.visibility==='hidden') return false;
          if(normalized(element.textContent)!==tag) return false;
          return ![...element.children].some(child=>normalized(child.textContent)===tag);
        });
      },tag,{timeout:10000}).catch(()=>{});
      const candidates=[];
      for(const item of await matches.all()) {
        if(!await item.isVisible()) continue;
        const selectable=await item.evaluate((element,tag)=>{
          const normalized=value=>String(value||'').replace(/\s+/g,'').replace(/^#/,'');
          return !element.closest('[contenteditable=true]')&&normalized(element.textContent)===tag&&![...element.children].some(child=>normalized(child.textContent)===tag);
        },tag);
        if(selectable) candidates.push(item);
      }
      if(candidates.length!==1) throw attention(`抖音没有显示唯一的“#${tag}”话题候选，请在发布窗口检查标签。`);
      await candidates[0].click();
      selected.push(tag);
      await editor.press('End');
      await editor.press('Space');
    }
    return {tags:selected,verified:true};
  }
  async selectMusic(preferred, rotation={}) {
    const musicSection=this.page.locator('[class^="container-JngpiB"]');
    const trigger=await this.one(musicSection.getByText(/^(选择音乐|修改音乐)$/),'抖音页面未找到音乐入口，尚不能满足带音乐发布');
    await trigger.click();
    await this.page.getByPlaceholder('搜索音乐',{exact:true}).waitFor({timeout:15000});
    let source=rotation.userChosen?'手动指定':'原草稿音乐';
    if(preferred) {
      const search=await this.visible(this.page.getByPlaceholder(/搜索音乐|搜索歌曲/));
      if(search.length!==1) throw attention('无法确认音乐搜索框，请在发布窗口检查。');
      await search[0].fill(preferred); await search[0].press('Enter');
    } else {
      const favoriteTab=this.page.getByRole('tab',{name:'收藏',exact:true});
      await favoriteTab.waitFor({state:'visible',timeout:5000}).catch(()=>{});
      const favorite=await this.visible(favoriteTab);
      if(favorite.length!==1) throw attention('没有找到抖音“收藏”歌单，请先在发布账号中收藏可用音乐。');
      await favorite[0].click();source='抖音收藏';
      await this.page.waitForTimeout(400);
    }
    // Inspect actual selectable rows. Never invent a song or silently omit music.
    await this.page.locator('[class*="song-name"]').first().waitFor({timeout:15000}).catch(()=>{});
    const candidates=preferred ? await this.musicOptions(100) : await this.loadMusicOptions();
    if(!candidates.length) throw attention(preferred?'没有找到指定音乐，请检查歌名后重新准备。':'收藏歌单里没有读取到可用音乐，请先收藏音乐后重新准备。');
    let selected,cycleRestarted=false,favoriteCount=null;
    if(preferred) {
      selected=candidates.find(candidate=>candidate.title.trim()===preferred.trim());
      if(!selected) throw attention(`没有找到指定音乐“${preferred}”，请检查歌名后重新准备。`);
    } else {
      const choice=chooseRotatingMusic(candidates,rotation.usedKeys||[]);
      selected=choice?.candidate;cycleRestarted=Boolean(choice?.cycleRestarted);favoriteCount=choice?.favoriteCount||candidates.length;
    }
    if(!selected) throw attention('收藏歌单里没有读取到可用音乐，请先收藏音乐后重新准备。');
    await selected.row.hover();await selected.button.click();
    await musicSection.locator('[class^="sub-desc-title-"]').filter({hasText:selected.title}).waitFor({timeout:15000});
    return {title:selected.title,author:selected.author,duration:selected.duration,source,verified:true,userChosen:Boolean(rotation.userChosen),rotationKey:selected.rotationKey||musicRotationKey(selected),rotationCycle:Number(rotation.cycle||1),rotationCycleRestarted:cycleRestarted,rotationFavoriteCount:favoriteCount};
  }
  async selectDeclaration() {
    const required='无需添加自主声明';
    const selected=await this.visible(this.page.locator('[class*="selectText-"][class*="selected-"]').filter({hasText:new RegExp(`^${required}$`)}));
    if(selected.length===1) return {label:required,verified:true};
    const trigger=await this.one(this.page.getByText('请选择自主声明',{exact:true}),'抖音页面未找到自主声明入口');
    await trigger.click();
    const modal=this.page.locator('.semi-modal-content').filter({hasText:'自主声明'});
    await modal.waitFor({state:'visible',timeout:10000});
    const option=await this.one(modal.locator('label.semi-radio').filter({hasText:new RegExp(`^${required}$`)}),'无法确认“无需添加自主声明”选项');
    await option.click();
    const confirm=await this.one(modal.getByRole('button',{name:'确定',exact:true}),'无法确认自主声明弹窗的确定按钮');
    await confirm.click();
    await this.page.locator('[class*="selectText-"][class*="selected-"]').filter({hasText:new RegExp(`^${required}$`)}).waitFor({state:'visible',timeout:10000});
    return {label:required,verified:true};
  }
  async loadMusicOptions() {
    const rows=this.page.locator('[class*="card-container"]').filter({has:this.page.locator('[class*="song-name"]')});
    let previous=-1,stable=0;
    for(let pass=0;pass<12;pass++) {
      const count=await rows.count();
      stable=count===previous?stable+1:0;previous=count;
      if(count) await rows.nth(count-1).scrollIntoViewIfNeeded().catch(()=>{});
      if(stable>=2 || count>=200) break;
      await this.page.waitForTimeout(250);
    }
    return this.musicOptions(200);
  }
  async musicOptions(limit=200) {
    const rows=await this.visible(this.page.locator('[class*="card-container"]').filter({has:this.page.locator('[class*="song-name"]')}));
    const options=[];
    for(const row of rows.slice(0,limit)) {
      const title=await row.locator('[class*="song-name"]').first().innerText().catch(()=>null);
      const author=await row.locator('[class*="song-author"]').first().innerText().catch(()=>'');
      const duration=await row.locator('[class*="song-duration"]').first().innerText().catch(()=>'');
      await row.hover();
      const button=row.getByRole('button',{name:'使用',exact:true});
      const usable=await button.isVisible().catch(()=>false);
      if(title && title.length<100 && usable) options.push({title:title.trim(),author:author.trim(),duration:duration.trim(),rotationKey:musicRotationKey({title,author,duration}),button,row});
    }
    return options;
  }
  async formProof(snapshot) {
    await this.checkChallenge();
    const title=await this.one(this.page.getByPlaceholder(/填写作品标题|添加作品标题|标题/),'标题输入框发生变化');
    const editor=await this.one(this.page.locator('[contenteditable=true]'),'正文输入框发生变化');
    const titleValue=await title.inputValue(), body=await editor.innerText(), text=await this.page.locator('body').innerText();
    const normalize=s=>s.replace(/[\s\u200B-\u200D\uFEFF]+/g,'');
    if(titleValue!==snapshot.douyinTitle || normalize(body)!==normalize(`${snapshot.body}\n${snapshot.tags.map(t=>'#'+t).join(' ')}`)) throw attention('发布窗口的文案与总览不一致，请重新准备。');
    const location=await this.page.locator('[class^="anchor-component-"] .semi-select-selection-text').innerText();
    const music=await this.page.locator('[class^="container-JngpiB"] [class^="sub-desc-title-"]').innerText();
    if(location!==COMPANY || music!==snapshot.music.title) throw attention('尚未在发布表单确认公司位置和所选音乐，请重新准备。');
    const declarations=await this.visible(this.page.locator('[class*="selectText-"][class*="selected-"]').filter({hasText:/^无需添加自主声明$/}));
    if(declarations.length!==1) throw attention('尚未在发布表单确认“无需添加自主声明”，请重新准备。');
    await this.assertPublic();
    if(/上传中|上传失败|处理中|上传异常/.test(text)) throw attention('图片仍在上传或处理，请等待后重新准备。');
    // DOM proof includes image order so edits in the publisher invalidate approval.
    const media=await this.page.locator('[class^="img-Sb1Kaq"] img').evaluateAll(nodes=>nodes.filter(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}).map(n=>({url:new URL(n.currentSrc||n.src).href,loaded:n.complete&&n.naturalWidth>0})));
    const unique=new Set(media.map(m=>m.url)).size;
    if(media.length!==snapshot.imageIds.length || unique!==media.length) throw attention(`上传图片与总览不一致（总览 ${snapshot.imageIds.length} 张，页面识别 ${media.length} 张、有效 ${unique} 张），请重新准备。`);
    return fingerprint({titleValue,body:normalize(body),media,music:snapshot.music,location:snapshot.location});
  }
  async submit(draft, beforeClick) {
    const prepared=this.prepared;
    if(!prepared || prepared.id!==draft.id || prepared.revision!==draft.revision) throw attention('草稿已修改或发布窗口已关闭，请重新准备后审阅。');
    await this.verifyAccount();
    const proof=await this.formProof(prepared.snapshot);
    if(proof!==prepared.proof) throw attention('发布窗口中的图片或内容发生变化，请重新准备并审阅。');
    const button=await this.one(this.page.getByRole('button',{name:'发布',exact:true}),'无法确认最终发布按钮');
    if(!await button.isEnabled()) throw attention('抖音发布按钮尚不可用，请检查页面提示。');
    await beforeClick(); // Durable submit intent is recorded before the external write.
    this.prepared=null;
    await button.click({timeout:10000});
    await this.page.getByText(/发布成功|提交成功|审核中/).first().waitFor({timeout:20000}).catch(()=>{});
    const text=await this.page.locator('body').innerText();
    // A generic content list isn't evidence that this exact post was published.
    const receipt=await this.page.locator('a[href*="douyin.com/note/"],a[href*="douyin.com/video/"]').evaluateAll(nodes=>nodes.map(n=>({url:n.href,text:n.innerText}))).catch(()=>[]);
    const identifier=publicIdentifier(draft);
    const match=identifier ? receipt.filter(r=>r.text.includes(identifier)) : [];
    if(match.length===1 && /发布成功|已发布/.test(text)) return {status:'published',receiptUrl:match[0].url};
    if(/发布成功|提交成功|审核中/.test(text)) return {status:'submitted',receiptUrl:null,message:'抖音已确认提交，待核对审核结果和作品链接。'};
    return {status:'uncertain',receiptUrl:null,message:'尚未确认提交结果。请核查抖音内容管理，系统不会自动重发。'};
  }
  async reconcile(draft) {
    await this.connect(); await this.verifyAccount();
    // Read-only reconciliation: never navigates to a composer or clicks Publish.
    const page=await this.context.newPage();
    try {
      await page.goto('https://creator.douyin.com/creator-micro/content/manage',{waitUntil:'domcontentloaded'});
      const identifier=publicIdentifier(draft);
      if(!identifier) return {status:draft.status,message:'这条作品缺少可核对的公开文案，请在内容管理手动核对；不会自动重发。'};
      await page.getByText(identifier,{exact:false}).first().waitFor({timeout:10000}).catch(()=>{});
      const rows=await page.getByText(identifier,{exact:true}).all();
      if(rows.length!==1) return {status:draft.status,message:'未能唯一定位这条作品，请在内容管理核对；不会自动重发。'};
      const row=rows[0].locator('xpath=..');
      const text=await row.innerText();
      const hrefs=await row.locator('a[href]').evaluateAll(ns=>ns.map(n=>n.href));
      const url=hrefs.find(h=>/^https:\/\/www\.douyin\.com\/(note|video)\/\d+/.test(h));
      if(/未通过|审核不通过/.test(text)) return {status:'rejected',message:'抖音审核未通过，请查看平台原因。'};
      if(/审核中/.test(text)) return {status:'submitted',message:'抖音仍在审核。'};
      if(url && /已发布|公开/.test(text)) return {status:'published',receiptUrl:url};
      return {status:draft.status,message:'已找到同名内容，仍需核对发布状态和作品链接。'};
    } finally {await page.close();}
  }
}
