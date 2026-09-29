import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprint } from './publish-analysis.mjs';

const MANAGE='https://mp.sohu.com/mpfe/v4/contentManagement/first/page';
const EDITOR='https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle';
const attention=message=>Object.assign(new Error(message),{code:'NEEDS_ATTENTION'});
const normalize=value=>String(value||'').replace(/[\s\u200B-\u200D\uFEFF]+/g,'');

export class SohuPublisher {
  constructor({root}){this.root=root;this.context=null;this.page=null;this.prepared=null;this.connecting=null;}
  async connect(){
    if(this.connecting)return this.connecting;
    this.connecting=this.open().finally(()=>{this.connecting=null;});return this.connecting;
  }
  async open(){
    if(!this.context){
      const profile=join(this.root,'data','publishing','sohu-chromium-profile');await mkdir(profile,{recursive:true});
      try{this.context=await chromium.launchPersistentContext(profile,{headless:false,viewport:null,args:['--start-maximized']});this.context.setDefaultTimeout(15000);}
      catch{throw attention('搜狐发布浏览器未能启动，请关闭重复的搜狐发布窗口后重试。');}
      this.context.on('close',()=>{this.context=null;this.page=null;this.prepared=null;});
    }
    this.page=this.context.pages().find(page=>page.url().includes('mp.sohu.com')) || await this.context.newPage();
    if(!this.page.url().includes('mp.sohu.com'))await this.page.goto(MANAGE,{waitUntil:'commit',timeout:15000}).catch(error=>{if(!this.page.url().includes('mp.sohu.com'))throw error;});
    await this.page.bringToFront();return this.status();
  }
  async status(){
    if(!this.page||this.page.isClosed())return{connected:false,ready:false,message:'请连接搜狐发布窗口'};
    const url=this.page.url();
    if(/\/login(?:[/?#]|$)/.test(url))return{connected:true,ready:false,message:'请在独立搜狐窗口手动登录，登录一次后会保留会话'};
    const text=await this.page.locator('body').innerText({timeout:3000}).catch(()=>'');
    const editorReady=await this.page.locator('input[placeholder*="请输入标题"], .ql-editor[contenteditable="true"]').first().isVisible().catch(()=>false);
    if(editorReady)return{connected:true,ready:true,message:'已连接搜狐号发布会话'};
    const login=/\/login(?:[/?#]|$)/.test(url)||/手机验证码|微信扫码|账号密码|登录搜狐号/.test(text);
    const ready=!login&&(editorReady||/内容管理|发布文章|创作中心|图文管理/.test(text)||/\/contentManagement(?:[/?#]|$)/.test(url));
    return{connected:true,ready,message:login?'请在独立搜狐窗口手动登录，登录一次后会保留会话':ready?'已连接搜狐号发布会话':'搜狐页面正在加载或等待账号核对'};
  }
  async visible(locator){const all=await locator.all(),result=[];for(const item of all)if(await item.isVisible().catch(()=>false))result.push(item);return result;}
  async one(locator,message){const list=await this.visible(locator);if(list.length!==1)throw attention(message);return list[0];}
  async verifyLogin(){const state=await this.status();if(!state.ready)throw attention('请先在搜狐发布窗口完成登录，再回到系统重新准备。');}
  async titleField(){
    const preferred=this.page.locator('input[placeholder*="标题"],textarea[placeholder*="标题"]');
    const list=await this.visible(preferred);if(list.length===1)return list[0];
    const named=await this.visible(this.page.getByRole('textbox',{name:/标题/}));if(named.length===1)return named[0];
    throw attention('搜狐编辑页的标题输入框已变化，请在发布窗口检查。');
  }
  async bodyEditor(){
    const selectors=['.ProseMirror','.ql-editor','.w-e-text','[contenteditable="true"][data-placeholder]','[contenteditable="true"]'];
    for(const selector of selectors){const list=await this.visible(this.page.locator(selector));const viable=[];for(const item of list){const box=await item.boundingBox();if(box&&box.width>400&&box.height>120)viable.push(item);}if(viable.length===1)return viable[0];}
    throw attention('搜狐编辑页的正文区域已变化，请在发布窗口检查。');
  }
  async setBody(editor,body){
    const paragraphs=String(body).split(/\n{2,}/).map(item=>item.trim()).filter(Boolean);
    await editor.evaluate((node,items)=>{node.innerHTML=items.map(item=>`<p>${item.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</p>`).join('');node.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null}));},paragraphs);
  }
  async uploadDialog(trigger,file,message){
    // Sohu currently uses two upload variants. Some accounts open an in-page
    // modal; others immediately open the browser file chooser. Waiting for the
    // chooser before clicking prevents a native dialog from blocking the whole
    // preparation workflow.
    const chooserPromise=this.page.waitForEvent('filechooser',{timeout:3500}).catch(()=>null);
    await trigger.click({timeout:6000,noWaitAfter:true}).catch(()=>{throw attention(`${message}：上传入口没有响应。`);});
    const chooser=await chooserPromise;
    if(chooser){await chooser.setFiles(file);await this.page.waitForTimeout(1500);return;}
    const dialog=this.page.locator('.win-mask:visible, .el-dialog:visible, [role="dialog"]:visible').last();
    await dialog.waitFor({state:'visible',timeout:6000}).catch(()=>{throw attention(`${message}：没有出现图片选择窗口。`);});
    // The picker opens on “正文图片”. A new local file must be uploaded from
    // “本地上传” first; otherwise Sohu accepts the upload request but never
    // adds the returned image to the selectable list, leaving “确定” disabled.
    const localUploadTabs=await this.visible(dialog.getByText('本地上传',{exact:true}));
    if(localUploadTabs.length!==1)throw attention(`${message}：没有找到“本地上传”选项。`);
    await localUploadTabs[0].click({timeout:6000});
    await this.page.waitForTimeout(400);
    const inputs=dialog.locator('input[type=file]');const count=await inputs.count();if(!count)throw attention(`${message}：没有找到文件入口。`);
    const uploadEvents=[];
    const onResponse=response=>{if(/upload|image|material|pic/i.test(response.url()))uploadEvents.push({type:'response',status:response.status(),url:response.url().slice(0,300)});};
    const onFailed=request=>{if(/upload|image|material|pic/i.test(request.url()))uploadEvents.push({type:'failed',failure:request.failure()?.errorText||'',url:request.url().slice(0,300)});};
    this.page.on('response',onResponse);this.page.on('requestfailed',onFailed);
    const uploadResponsePromise=this.page.waitForResponse(response=>/\/outerUpload\/image\/file/i.test(response.url()),{timeout:60000}).catch(()=>null);
    await inputs.last().setInputFiles(file);
    const uploadResponse=await uploadResponsePromise;
    const uploadResponseText=uploadResponse?await uploadResponse.text().catch(()=>''):'';
    if(!uploadResponse||uploadResponse.status()>=400){this.page.off('response',onResponse);this.page.off('requestfailed',onFailed);throw attention(`${message}：搜狐图片上传接口没有成功返回。`);}
    await this.page.waitForTimeout(2500);
    let uploaded;try{uploaded=JSON.parse(uploadResponseText);}catch{uploaded=null;}
    if(!uploaded?.url){this.page.off('response',onResponse);this.page.off('requestfailed',onFailed);throw attention(`${message}：搜狐没有返回可用图片地址。`);}
    const confirm=await this.one(dialog.getByText('确定',{exact:true}),`${message}：未能唯一确认“确定”按钮。`);
    this.page.off('response',onResponse);this.page.off('requestfailed',onFailed);
    const isConfirmEnabled=async()=>confirm.evaluate(node=>!node.disabled&&node.getAttribute('aria-disabled')!=='true'&&!/(?:^|\s)(?:disabled|disable-button)(?:\s|$)/i.test(String(node.className||''))).catch(()=>false);
    // Uploading creates a thumbnail but does not always select it. Prefer the
    // newest large visible thumbnail and only continue after Sohu enables the
    // modal's own confirmation action.
    if(!await isConfirmEnabled()){
      const thumbnails=await this.visible(dialog.locator('img'));
      const selectable=[];
      for(const image of thumbnails){const box=await image.boundingBox();if(box&&box.width>=60&&box.height>=60)selectable.push(image);}
      if(selectable.length){await selectable.at(-1).click({timeout:6000});await this.page.waitForTimeout(500);}
    }
    if(!await isConfirmEnabled()){
      await dialog.screenshot({path:join(this.root,'data','publishing','sohu-upload-debug.png')}).catch(()=>{});
      throw attention(`${message}：图片已经上传，但搜狐没有选中该图片。`);
    }
    await confirm.click({timeout:6000});await dialog.waitFor({state:'hidden',timeout:12000}).catch(async()=>{await dialog.screenshot({path:join(this.root,'data','publishing','sohu-upload-debug.png')}).catch(()=>{});throw attention(`${message}：图片窗口没有正常关闭。`);});
  }
  async setCover(file){
    const trigger=await this.one(this.page.getByText(/^(上传图片|更换图片)$/), '未能唯一确认搜狐文章封面上传位置，请在发布窗口检查。');
    await this.uploadDialog(trigger,file,'搜狐封面上传失败');
  }
  async insertInline(editor,file,paragraphNumber){
    await editor.evaluate((node,index)=>{const items=node.querySelectorAll('p');const target=items[Math.max(0,Math.min(items.length-1,index-1))]||node;const range=document.createRange();range.selectNodeContents(target);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);},paragraphNumber||2);
    const before=await editor.locator('img').count(),triggers=this.page.locator('button.ql-image, .ql-image, [data-name="image"], [aria-label*="图片"]'),trigger=await this.one(triggers,'未能唯一确认搜狐正文插图入口，请在发布窗口检查。');
    await this.uploadDialog(trigger,file,'搜狐正文插图上传失败');
    await editor.locator('img').nth(before).waitFor({state:'visible',timeout:15000}).catch(()=>{throw attention('搜狐正文图片上传后未出现在文章中，请在发布窗口检查。');});
  }
  async setCategory(){
    const trigger=await this.one(this.page.getByText('关联栏目',{exact:true}),'未能唯一确认搜狐栏目入口。');
    await trigger.click({timeout:6000});
    // The category picker is not the same dialog component as the image
    // picker. Anchor on its unique option instead of assuming a modal class.
    const categoryLocator=this.page.getByText('玩具经验分享',{exact:true});
    await categoryLocator.first().waitFor({state:'visible',timeout:8000}).catch(async()=>{await this.page.screenshot({path:join(this.root,'data','publishing','sohu-category-debug.png'),fullPage:true}).catch(()=>{});throw attention('搜狐栏目窗口没有正常打开。');});
    const category=await this.one(categoryLocator,'栏目中没有唯一的“玩具经验分享”。');
    await category.click();
    const confirm=await this.one(this.page.getByText('确定',{exact:true}),'栏目窗口没有唯一的“确定”按钮。');
    await confirm.click();await confirm.waitFor({state:'hidden',timeout:8000}).catch(()=>{throw attention('搜狐栏目没有完成确认。');});
  }
  async setCreationDeclaration(){
    const option=await this.one(this.page.getByText('含有AI生成内容',{exact:true}),'未能唯一确认“含有AI生成内容”创作声明。');
    await option.click();await this.page.waitForTimeout(300);
    const selected=await option.evaluate(node=>{for(let current=node,depth=0;current&&depth<6;current=current.parentElement,depth++){if(current.querySelector?.('input[type="radio"]:checked'))return true;const cls=String(current.className||'');if(/(?:^|\s)(?:checked|selected|active)(?:\s|$)/i.test(cls))return true;}return false;}).catch(()=>false);
    if(!selected)throw attention('“含有AI生成内容”创作声明点击后没有变为选中状态。');
  }
  async formProof(draft){
    const title=await this.titleField(),editor=await this.bodyEditor();
    const titleValue=await title.inputValue(),body=await editor.innerText();
    // Sohu adds an editor-only image-description affordance around every
    // inserted picture.  It is not article copy, so remove that platform UI
    // marker before comparing the saved editor text with the approved draft.
    const actualBody=normalize(body).replace(/点击添加图片描述（最多60个字）编辑/g,''),expectedParagraphs=String(draft.body).split(/\n{2,}/).map(normalize).filter(Boolean);
    let cursor=0,bodyMatches=true;
    for(const paragraph of expectedParagraphs){const next=actualBody.indexOf(paragraph,cursor);if(next<0){bodyMatches=false;break;}cursor=next+paragraph.length;}
    // Sohu may inject a small image placeholder between paragraphs. Requiring
    // every complete paragraph, unchanged and in order, keeps the content
    // safety check while allowing those platform-owned image markers.
    if(normalize(titleValue)!==normalize(draft.title)||!bodyMatches){
      await writeFile(join(this.root,'data','publishing','sohu-form-proof-debug.json'),JSON.stringify({titleValue,expectedTitle:draft.title,body,expectedBody:draft.body},null,2),'utf8').catch(()=>{});
      throw attention('搜狐发布窗口的标题或正文与总览不一致，请重新准备。');
    }
    const images=await editor.locator('img').evaluateAll(nodes=>nodes.filter(node=>{const box=node.getBoundingClientRect();return box.width>0&&box.height>0;}).map(node=>node.currentSrc||node.src));
    if(images.length!==draft.imageIds.length)throw attention('搜狐正文插图数量与总览不一致，请重新准备。');
    // After confirmation Sohu renders the selection as one combined label,
    // for example "已关联1个栏目：玩具经验分享", rather than as a standalone
    // exact text node. Verify the persisted summary instead of the picker item.
    const pageText=await this.page.locator('body').innerText();
    const categorySelected=/已关联\s*1\s*个栏目\s*[:：]?\s*玩具经验分享/.test(pageText);
    if(!categorySelected)throw attention('搜狐栏目尚未选择“玩具经验分享”。');
    const aiOption=this.page.getByText('含有AI生成内容',{exact:true});
    const aiSelected=await aiOption.first().evaluate(node=>{for(let current=node,depth=0;current&&depth<6;current=current.parentElement,depth++){if(current.querySelector?.('input[type="radio"]:checked'))return true;const cls=String(current.className||'');if(/(?:^|\s)(?:checked|selected|active)(?:\s|$)/i.test(cls))return true;}return false;}).catch(()=>false);
    if(!aiSelected)throw attention('搜狐创作声明尚未选择“含有AI生成内容”。');
    return fingerprint({title:normalize(titleValue),body:normalize(body),images});
  }
  async prepare(draft,assets){
    await this.connect();await this.verifyLogin();this.prepared=null;
    await this.page.goto(EDITOR,{waitUntil:'commit',timeout:30000});await this.page.locator('input[placeholder*="请输入标题"]').waitFor({state:'visible',timeout:15000});await this.verifyLogin();
    const title=await this.titleField(),editor=await this.bodyEditor();await title.fill(draft.title);await this.setBody(editor,draft.body);
    const summary=this.page.locator('textarea[placeholder="请输入摘要"]');if(await summary.count()===1)await summary.fill(String(draft.body).replace(/\s+/g,' ').trim().slice(0,120));
    const chosen=draft.imageIds.map(id=>assets.find(asset=>asset.id===id)).filter(Boolean);
    if(chosen.length<1||chosen.length>2)throw attention('搜狐文章需要 1–2 张相关照片。');
    await this.setCover(chosen[0].path);
    // Every selected picture appears in the article body as well. The first is
    // reused as the cover; a second picture is inserted later in the article.
    for(let index=0;index<chosen.length;index++)await this.insertInline(editor,chosen[index].path,index===0?3:(draft.imageAfterParagraphs?.[index]||7));
    await this.setCategory();
    await this.setCreationDeclaration();
    await this.page.waitForTimeout(1000);
    const proof=await this.formProof(draft);this.prepared={id:draft.id,revision:draft.revision,proof};
    return{preparedAt:new Date().toISOString(),sohuForm:{verified:true,title:draft.title,imageCount:chosen.length}};
  }
  async submit(draft,beforeClick){
    const prepared=this.prepared;if(!prepared||prepared.id!==draft.id||prepared.revision!==draft.revision)throw attention('搜狐草稿已修改或发布窗口已关闭，请重新准备。');
    await this.verifyLogin();if(await this.formProof(draft)!==prepared.proof)throw attention('搜狐发布窗口内容发生变化，请重新准备并审阅。');
    // Sohu can render another visible "发布" control in its page chrome.  The
    // actionable article button is the enabled one lowest on the editor page.
    // Prefer that deterministic control rather than treating the duplicate as
    // a reason to leave an otherwise verified article stuck before submission.
    const nativeCandidates=await this.visible(this.page.locator('button,[role=button],.button').filter({hasText:/^发布$/}));
    // The current Sohu editor renders the yellow footer action as a styled
    // element with an inner text node, not necessarily as a native button.
    // Lift the exact label to its nearest clickable component as well.
    const labelled=[];
    const labels=await this.visible(this.page.getByText('发布',{exact:true}));
    for(const label of labels){
      const control=label.locator('xpath=ancestor-or-self::*[self::button or @role="button" or contains(@class,"button") or contains(@class,"btn")][1]');
      if(await control.count().catch(()=>0))labelled.push(control.first());
    }
    const candidates=[...new Set([...nativeCandidates,...labelled])];
    const actionable=[];
    for(const button of candidates){
      const text=(await button.innerText().catch(()=>'' )).trim();
      const disabled=await button.evaluate(node=>node.classList.contains('disable-button')||node.getAttribute('aria-disabled')==='true'||node.disabled===true).catch(()=>true);
      const enabled=!disabled&&await button.isEnabled().catch(()=>false);
      const box=await button.boundingBox().catch(()=>null);
      if(text==='发布'&&enabled&&box)actionable.push({button,box});
    }
    if(!actionable.length){
      const details=[];
      for(const button of candidates){
        details.push(await button.evaluate(node=>({
          text:(node.innerText||'').trim(),
          disabled:node.disabled===true,
          ariaDisabled:node.getAttribute('aria-disabled'),
          className:String(node.className||''),
          title:node.getAttribute('title')||''
        })).catch(()=>({unreadable:true})));
      }
      await this.page.screenshot({path:join(this.root,'data','publishing','sohu-publish-debug.png'),fullPage:true}).catch(()=>{});
      await writeFile(join(this.root,'data','publishing','sohu-publish-debug.json'),JSON.stringify(details,null,2),'utf8').catch(()=>{});
      throw attention('搜狐发布按钮尚不可用，请检查页面提示。');
    }
    actionable.sort((a,b)=>b.box.y-a.box.y);
    const publishButton=actionable[0].button;
    await beforeClick();this.prepared=null;await publishButton.click();
    await this.page.getByText(/发布成功|提交成功|审核中/).first().waitFor({timeout:20000}).catch(()=>{});
    const text=await this.page.locator('body').innerText();
    if(/发布成功|提交成功|审核中/.test(text))return{status:'submitted',receiptUrl:null,message:'搜狐号已确认提交，待核对审核结果和公开链接。'};
    return{status:'uncertain',receiptUrl:null,message:'尚未确认搜狐提交结果，请核查内容管理；系统不会自动重发。'};
  }
  async reconcile(draft){
    await this.connect();await this.verifyLogin();const page=await this.context.newPage();
    try{await page.goto(MANAGE,{waitUntil:'commit',timeout:30000});await page.getByText(draft.title,{exact:false}).first().waitFor({timeout:12000}).catch(()=>{});const matches=await page.getByText(draft.title,{exact:true}).all();
      if(matches.length!==1)return{status:draft.status,message:'未能在搜狐内容管理中唯一定位该标题，请手动核对；不会自动重发。'};
      const row=matches[0].locator('xpath=ancestor::*[self::tr or self::li or self::div][1]'),text=await row.innerText();const hrefs=await row.locator('a[href]').evaluateAll(nodes=>nodes.map(node=>node.href));const url=hrefs.find(h=>/sohu\.com\/a\//.test(h));
      if(/审核不通过|未通过/.test(text))return{status:'rejected',message:'搜狐审核未通过，请查看平台原因。'};
      if(/审核中/.test(text))return{status:'submitted',message:'搜狐文章仍在审核。'};
      if(url)return{status:'published',receiptUrl:url,message:'已在搜狐内容管理找到这篇公开文章。'};
      return{status:draft.status,message:'已找到同名内容，仍需核对发布状态。'};
    }finally{await page.close();}
  }
}
