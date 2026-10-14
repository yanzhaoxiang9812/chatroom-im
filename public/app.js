// ============================================================
// 聊天室 PWA —— 后端：腾讯云IM(实时) + Supabase(历史存档/图片)
// ============================================================
// 【你需要填写/补齐的配置，见下面几个"IM_"开头项和底部注释】
//  1. 腾讯云IM：SDKAppID / 直播群(AVChatRoom)ID / UserSig 生成接口
//  2. Supabase：现有项目已配好(下面 SUPABASE_URL/KEY)；图片存储需要建 bucket
//  3. 静态资源：public/vendor/tim-js.js (腾讯云IM Web SDK，需下载放入)
//  4. 数据库：messages 表需加一列 im_msg_id (去重用)
// ============================================================

// ===== Supabase 配置（保留：历史存档 + 图片存储）=====
var SUPABASE_URL = 'https://hsyoycckrvievaumlxnm.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzeW95Y2NrcnZpZXZhdW1seG5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NzQ2NzksImV4cCI6MjEwNzU1MDY3OX0.iRtrn6JJqyXrEvdFUYINzcDqrsf9Pjfht_oqDGocm8Q';
var supabase;

// ===== 腾讯云IM 配置（★ 需要你填 ★）=====
var IM_SDKAPPID = 1600166965;  // 腾讯云IM SDKAppID（已填）
var IM_ROOM_ID = '@TGS#aZGYNDZUN';  // 直播群(AVChatRoom) 群ID（已填）
var IM_BUCKET = 'chat-images'; // Supabase Storage 桶名，用于存图片（需先建好这个桶+公开读）

// UserSig 由 CloudBase HTTP 云函数(genUserSig) 用 SecretKey 生成，前端严禁放 SecretKey。
function getIMUserSig(userId){
  return new Promise(function(resolve, reject){
    fetch('https://chatroom-im-d1gwqd61s619ac465-1306353800.ap-shanghai.app.tcloudbase.com/genUserSig?userId=' + encodeURIComponent(userId))
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(j && j.userSig) resolve(j.userSig);
        else reject(new Error((j && j.error) || 'UserSig 接口未返回 userSig'));
      })
      .catch(function(e){ reject(new Error('获取 UserSig 失败：' + (e && e.message || e))); });
  });
}

// ===== 运行时状态 =====
var tim = null;              // 腾讯云IM SDK 实例
var myUserId = '';           // 腾讯云IM 登录账号ID(匿名生成，存localStorage)
var myName = '', currentRoomId = '', pendingImg = '';
var userStates = {};
var renderedIds = {};        // 已渲染消息id去重
var lastSeenTime = 0;

function avatarLetter(name){ return name ? name.charAt(0).toUpperCase() : '?'; }
function detectDevice(){ return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'mobile' : 'desktop'; }

document.getElementById('msg-input').addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(); } });
document.getElementById('msg-input').addEventListener('focus', function(){ var p=document.getElementById('emoji-panel'); if(p) p.style.display='none'; });

function showImgPreview(dataUrl){
  pendingImg=dataUrl;
  var pv=document.getElementById('img-preview');
  pv.innerHTML='';
  var img=document.createElement('img'); img.src=dataUrl;
  var rm=document.createElement('button'); rm.className='remove-img'; rm.textContent='×'; rm.onclick=function(){ pendingImg=''; pv.style.display='none'; pv.innerHTML=''; };
  pv.appendChild(img); pv.appendChild(rm); pv.style.display='block';
}
function handleFileSelect(input){
  var file=input.files&&input.files[0];
  if(!file) return;
  if(file.size>10485760){ showToast('图片太大，请压缩后再发'); input.value=''; return; }
  var reader=new FileReader();
  reader.onload=function(ev){ showImgPreview(ev.target.result); };
  reader.readAsDataURL(file);
  input.value='';
}
document.getElementById('msg-input').addEventListener('paste', function(e){
  var items=e.clipboardData&&e.clipboardData.items;
  if(!items) return;
  for(var i=0;i<items.length;i++){
    if(items[i].type.indexOf('image')===0){
      e.preventDefault();
      var file=items[i].getAsFile();
      var reader=new FileReader();
      reader.onload=function(ev){
        if(ev.target.result.length>10485760){ showToast('图片太大，请压缩后再发'); return; }
        showImgPreview(ev.target.result);
      };
      reader.readAsDataURL(file);
      return;
    }
  }
});

// ============================================================
// 数据层：统一消息对象 { id, imId, name, text, img, time, type }
//   id   : 前端唯一渲染id(历史='m'+row.id / 实时='im'+IMmsg.ID / 乐观='tmp...')
//   imId : 腾讯云IM消息ID(Supabase 存档去重用)；历史行从 im_msg_id 读
//   type : 'chat' | 'system'
// ============================================================

// Supabase 历史行 -> 统一消息对象
function toMsg(row){
  return {
    id: 'm' + row.id,
    imId: row.im_msg_id || null,
    name: row.name,
    text: row.text || '',
    img: row.img || null,
    time: Date.parse(row.created_at) || Date.now(),
    type: row.type === 'system' ? 'system' : 'chat'
  };
}
// 历史：从 Supabase 倒序取最新 20 条
function loadHistory(roomId){
  return supabase.from('messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(20);
}
// 存档到 Supabase（按 imId 去重，避免同一条消息重复入库）
function saveToSupabase(msg){
  if(!supabase || !currentRoomId || !msg.imId) return;
  supabase.from('messages').select('id').eq('im_msg_id', msg.imId).limit(1).then(function(res){
    if(res && res.data && res.data.length) return; // 已存在
    supabase.from('messages').insert({
      room_id: currentRoomId,
      name: msg.name,
      text: msg.text || null,
      img: msg.img || null,
      type: msg.type === 'system' ? 'system' : 'chat',
      im_msg_id: msg.imId
    }).then(function(){}).catch(function(e){ console.error('存档失败', e); });
  }).catch(function(){});
}
// 系统消息存档（改名/进出房等）。imId 本地生成，保证不重复
function insertSystem(text){
  if(!currentRoomId) return;
  var sys = { id:'sys'+Date.now()+Math.floor(Math.random()*9999), imId:'sys'+Date.now()+Math.floor(Math.random()*9999), name:'System', text:text, img:null, time:Date.now(), type:'system' };
  saveToSupabase(sys);
}

// 统一渲染入口：按 id 去重 + 乐观占位替换
function renderIncoming(msg){
  if(!msg) return;
  if(msg.id && renderedIds[msg.id]) return;
  if(msg.id) renderedIds[msg.id]=1;
  if(Object.keys(renderedIds).length>600) renderedIds={};
  if(msg.time>lastSeenTime) lastSeenTime=msg.time;
  var m=document.getElementById('messages');
  // 乐观占位替换：自己刚发的 tmp 消息，收到真实消息后更新那条占位(换成真实id/时间)，避免重复
  if(msg.name===myName && m){
    var rows=m.querySelectorAll('[data-msg-id^="tmp"]');
    for(var k=0;k<rows.length;k++){
      var el=rows[k];
      var bub=el.querySelector('.msg-bubble');
      if(!bub) continue;
      var same=false;
      var im=bub.querySelector('img');
      if(msg.img){ same=!!(im && im.src===msg.img); }
      else if(im){ same=(im.alt===msg.text); }
      else { same=(bub.textContent===msg.text); }
      if(same){
        el.setAttribute('data-msg-id', msg.id);
        var tm=el.querySelector('.msg-time'); if(tm) tm.textContent=fmtTime(msg.time);
        if(m) m.scrollTop=m.scrollHeight;
        return;
      }
    }
  }
  if(msg.type==='system'){ appendSystem(msg.text||''); }
  else { appendMessage(msg); }
  if(m) m.scrollTop=m.scrollHeight;
}

// ============================================================
// 腾讯云IM：实时层（收发消息 / 进出房 / 在线列表）
// ============================================================
function initTIM(){
  if(!window.TIM) return Promise.reject(new Error('TIM SDK 未加载(检查 public/vendor/tim-js.js)'));
  tim = window.TIM.create({ SDKAppID: IM_SDKAPPID });
  // 上传插件：发图片/表情消息必需（public/vendor/tim-upload-plugin.js）
  if(window.TIMUploadPlugin){ tim.registerPlugin({ 'tim-upload-plugin': window.TIMUploadPlugin }); }
  else { console.warn('[IM] tim-upload-plugin 未加载，图片/表情将无法发送'); }
  tim.on(window.TIM.EVENT.MESSAGE_RECEIVED, onIMMessage);
  // 群系统通知：进出群、被踢等。用于"xx进入房间"提示 + 在线列表
  tim.on(window.TIM.EVENT.GROUP_SYSTEM_NOTICE_RECEIVED, onIMGroupNotice);
  return Promise.resolve();
}
async function loginIM(){
  if(!tim) throw new Error('TIM 未初始化');
  if(!myUserId){ myUserId = 'u' + Math.floor(Math.random()*90000000+10000000); try{ localStorage.setItem('xchat_imid', myUserId); }catch(e){} }
  var userSig = await getIMUserSig(myUserId);  // ★ 依赖你配置的接口
  await tim.login({ userID: myUserId, userSig: userSig });
  // 同步昵称
  try{ await tim.updateMyProfile({ nick: myName }); }catch(e){}
}
async function joinIMRoom(){
  await tim.joinGroup({ groupID: IM_ROOM_ID, type: window.TIM.TYPES.GRP_AVCHATROOM });
}

// 收到实时消息（含自己发的）：渲染 + 文字存档
function onIMMessage(event){
  var msgs = event.data || [];
  msgs.forEach(function(raw){
    var msg = parseIMMessage(raw);
    if(!msg) return;
    renderIncoming(msg);
    if(msg.type==='chat' && msg.text){ saveToSupabase(msg); } // 图片走 IM 托管，仅文字存档
  });
}
// 腾讯云IM消息 -> 统一消息对象
function parseIMMessage(raw){
  try{
    var type = raw.type;
    var base = { imId: raw.ID || null, name: raw.nickname || raw.from || '用户', time: (raw.time||0)*1000, type:'chat' };
    if(type === window.TIM.TYPES.MSG_TEXT){
      base.id = 'im' + raw.ID;
      base.text = (raw.payload && raw.payload.text) || '';
      base.img = null;
      return base;
    }
    if(type === window.TIM.TYPES.MSG_CUSTOM){
      var data = raw.payload && raw.payload.data;
      var obj = JSON.parse(data || '{}');
      if(obj && obj.img){
        base.id = 'im' + raw.ID;
        base.text = '';
        base.img = obj.img;
        return base;
      }
    }
    if(type === window.TIM.TYPES.MSG_IMAGE){
      // 腾讯云IM 原生图片消息：imageInfoArray 里取尺寸最大的 url
      var arr = (raw.payload && raw.payload.imageInfoArray) || [];
      var url = '';
      for(var i=0;i<arr.length;i++){ if(arr[i].url){ url = arr[i].url; } }
      if(url){
        base.id = 'im' + raw.ID;
        base.text = '';
        base.img = url;
        return base;
      }
    }
  }catch(e){ console.error('[IM] 解析消息失败', e); }
  return null;
}
// 群系统通知：进群/退群提示 + 刷新在线列表
function onIMGroupNotice(event){
  try{
    var data = event.data;
    var msg = data && data.message;
    var tips = msg && msg.tipGroupInfo;
    // ★ 提示文案与字段以你腾讯云IM SDK 版本为准，这里给出常见写法
    if(tips && tips.userList){
      tips.userList.forEach(function(u){
        var nm = u.nickname || u.userID || '用户';
        if(data.opType === 1){ appendSystem(nm + ' 进入了房间'); }
        else if(data.opType === 2){ appendSystem(nm + ' 离开了房间'); }
      });
    }
  }catch(e){}
  updateOnlineList();
}
// 在线名单(绿红点)：从直播群成员列表读取
function updateOnlineList(){
  if(!tim) return;
  tim.getGroupMemberList({ groupID: IM_ROOM_ID, count: 100, offset: 0 }).then(function(imResponse){
    var members = (imResponse.data && imResponse.data.memberList) || [];
    var present = {};
    members.forEach(function(m){ var n=m.nickname||m.userID; if(n) present[n]=1; });
    var now=Date.now();
    Object.keys(userStates).forEach(function(n){
      if(n===myName) return;
      if(!present[n]){
        if(userStates[n].visible===true) userStates[n].leftAt=now;
        userStates[n].visible=false;
      }
    });
    Object.keys(present).forEach(function(n){ userStates[n]={ device:detectDevice(), visible:true, leftAt:0 }; });
    updateStatusDisplay();
  }).catch(function(){});
}

// ============================================================
// 进房 / 发送
// ============================================================
function joinRoom(roomId){
  roomId=String(roomId).trim();
  if(!roomId){ showToast('请输入房间号'); return; }
  var savedName=''; try{ savedName=localStorage.getItem('xchat_name')||''; }catch(e){}
  myName=savedName||('用户'+Math.floor(Math.random()*9000+1000));
  try{ myUserId=localStorage.getItem('xchat_imid')||''; }catch(e){}
  doJoin(roomId);
}
function doJoin(roomId){
  currentRoomId=roomId;

  // 1) 加载历史：从 Supabase 倒序取最新20条
  loadHistory(roomId).then(function(res){
    var m=document.getElementById('messages');
    m.innerHTML='';
    var list=(res.data||[]).slice().reverse();
    for(var i=0;i<list.length;i++){
      var msg=toMsg(list[i]);
      if(msg.id) renderedIds[msg.id]=1;
      if(msg.time>lastSeenTime) lastSeenTime=msg.time;
      if(msg.type==='system'){ appendSystem(msg.text); } else { appendMessage(msg); }
    }
    appendSystem('你进入了房间 #'+roomId);
    setTimeout(function(){ m.scrollTop=m.scrollHeight; },50);
    document.getElementById('msg-input').focus();
    try{ localStorage.setItem('xchat_lastroom',roomId); }catch(e){}
  }).catch(function(e){
    console.error('[chatroom] 历史消息加载失败', e);
    showToast('加载历史消息失败：' + (e&&e.message?e.message:'网络异常'));
  });

  // 2) 连接腾讯云IM实时通道：登录 + 进直播群
  initTIM().then(function(){
    return loginIM();
  }).then(function(){
    return joinIMRoom();
  }).then(function(){
    console.log('[IM] 已加入直播群', IM_ROOM_ID);
    updateOnlineList();
  }).catch(function(e){
    console.error('[IM] 实时连接失败', e);
    showToast('实时连接失败：' + (e&&e.message?e.message:'请检查IM配置'));
  });
}

// 发送前把图片压缩到小尺寸，省存储和流量
function compressImage(dataUrl, maxDim, quality){
  return new Promise(function(resolve){
    var img=new Image();
    img.onload=function(){
      var w=img.width,h=img.height;
      var scale=Math.min(1, maxDim/Math.max(w,h));
      if(scale<1){
        var canvas=document.createElement('canvas');
        canvas.width=Math.round(w*scale); canvas.height=Math.round(h*scale);
        var ctx=canvas.getContext('2d');
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
        var out=canvas.toDataURL('image/jpeg', quality||0.75);
        resolve(out);
      } else { resolve(dataUrl); }
    };
    img.onerror=function(){ resolve(dataUrl); };
    img.src=dataUrl;
  });
}
// dataURL -> Blob（Supabase Storage 上传用）
function dataUrlToBlob(dataUrl){
  var arr=dataUrl.split(','); var mime=arr[0].match(/:(.*?);/)[1];
  var b64=atob(arr[1]); var u8=new Uint8Array(b64.length);
  for(var i=0;i<b64.length;i++) u8[i]=b64.charCodeAt(i);
  return new Blob([u8], { type:mime });
}
// 图片上传到 Supabase Storage，返回公开 URL（★ 需先在 Supabase 建 bucket: IM_BUCKET）
function uploadImageToStorage(dataUrl){
  return new Promise(function(resolve, reject){
    if(!supabase){ reject(new Error('supabase 未就绪')); return; }
    var path = 'chat/' + Date.now() + '-' + Math.floor(Math.random()*1e6) + '.jpg';
    supabase.storage.from(IM_BUCKET).upload(path, dataUrlToBlob(dataUrl), { contentType:'image/jpeg' })
      .then(function(res){
        if(res.error){ reject(res.error); return; }
        var url = supabase.storage.from(IM_BUCKET).getPublicUrl(path).data.publicUrl;
        resolve(url);
      }).catch(reject);
  });
}
// 通过腾讯云IM发送
function dataUrlToFile(dataUrl, filename){
  var blob = dataUrlToBlob(dataUrl);
  return new File([blob], filename || 'img-' + Date.now() + '.jpg', { type: blob.type || 'image/jpeg' });
}
function sendTextMessage(text){
  var msg = tim.createTextMessage({
    to: IM_ROOM_ID,
    conversationType: window.TIM.TYPES.CONV_GROUP,
    payload: { text: text }
  });
  return tim.sendMessage(msg);
}
// 图片/表情包：腾讯云IM 原生图片消息（图片由腾讯云托管上传，不依赖 Supabase）
function sendImageMessage(dataUrl){
  var file = dataUrlToFile(dataUrl);
  var msg = tim.createImageMessage({
    to: IM_ROOM_ID,
    conversationType: window.TIM.TYPES.CONV_GROUP,
    payload: { file: file }
  });
  return tim.sendMessage(msg);
}
function doSendChat(text, img){
  if(!currentRoomId || !tim) return Promise.reject(new Error('实时未就绪'));
  if(img) return sendImageMessage(img); // 图片/表情：原生图片消息
  return sendTextMessage(text);         // 文字：文本消息
}
// 乐观秒显：自己发的消息立刻本地渲染(占位)，IM 回传真实消息后替换
function optimisticSend(text, img){
  var tempId='tmp'+Date.now()+Math.floor(Math.random()*99999);
  var opt={ id:tempId, name:myName, text:text||'', img:img||null, time:Date.now(), type:'chat' };
  appendMessage(opt);
}
function sendMessage(){
  var input=document.getElementById('msg-input');
  var text=input.value.trim();
  var img=pendingImg;
  if(!text&&!img) return;
  if(!currentRoomId) return;
  input.value=''; pendingImg='';
  if(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)){ input.blur(); } else { input.focus(); }
  var pv=document.getElementById('img-preview'); pv.style.display='none'; pv.innerHTML='';
  if(img){
    // 先压缩再发；压缩后的图同时用于乐观本地渲染，保证与 IM 回传一致能去重
    compressImage(img, 1280, 0.75).then(function(small){
      optimisticSend(text, small);
      doSendChat(text, small).catch(function(e){ removeOptimistic(); showToast('发送失败：'+(e&&e.message||e)); });
    });
  } else {
    optimisticSend(text, null);
    doSendChat(text, null).catch(function(e){ removeOptimistic(); showToast('发送失败：'+(e&&e.message||e)); });
  }
}
// 发送失败时移除本地乐观占位
function removeOptimistic(){
  var m=document.getElementById('messages');
  if(!m) return;
  var rows=m.querySelectorAll('[data-msg-id^="tmp"]');
  for(var i=0;i<rows.length;i++){ var r=rows[i]; if(r.parentNode) r.parentNode.removeChild(r); }
}

// ===== 界面层（保留原逻辑）=====
function appendMessage(msg){
  var m=document.getElementById('messages');
  if(!m) return;
  while(m.children.length>100){ m.removeChild(m.firstChild); }
  var isSelf=msg.name===myName;
  var row=document.createElement('div');
  row.className='msg-row '+(isSelf?'self':'other');
  if(msg.id) row.setAttribute('data-msg-id',msg.id);
  var av=document.createElement('div'); av.className='avatar'; av.textContent=avatarLetter(msg.name);
  row.appendChild(av);
  var body=document.createElement('div'); body.className='msg-body';
  var line=document.createElement('div'); line.className='msg-line';
  var nm=document.createElement('span'); nm.className='msg-name'; nm.textContent=isSelf?'我':msg.name;
  if(msg.name===myName){ nm.style.cursor='pointer'; nm.title='Click to rename'; nm.addEventListener('click',function(ev){ ev.stopPropagation(); showRenameModal(); }); }
  line.appendChild(nm);
  body.appendChild(line);
  var bub=document.createElement('div'); bub.className='msg-bubble';
  if(msg.img){
    bub.style.background='transparent'; bub.style.boxShadow='none';
    var isWechatEmoji=msg.img.indexOf('/emojis/')!==-1 || (msg.img.indexOf('data:image')===0&&msg.img.length<50000);
    var img=document.createElement('img'); img.src=msg.img;
    img.style.maxWidth=isWechatEmoji?'20px':'300px'; img.style.maxHeight=isWechatEmoji?'20px':'300px';
    img.style.borderRadius='8px'; img.style.cursor='pointer';
    img.onclick=function(){ openImgViewer(msg.img); };
    bub.appendChild(img);
  } else {
    if(isSingleEmoji(msg.text)){
      bub.style.background='transparent';
      bub.appendChild(twemojiImg(msg.text,16));
    } else { bub.textContent=msg.text; }
  }
  body.appendChild(bub);
  var tm=document.createElement('div'); tm.className='msg-time'; tm.textContent=fmtTime(msg.time); body.appendChild(tm);
  row.appendChild(body);
  m.appendChild(row);
  m.scrollTop=m.scrollHeight;
}
function appendSystem(text){
  var m=document.getElementById('messages');
  var div=document.createElement('div'); div.className='msg system'; div.textContent=text;
  m.appendChild(div); m.scrollTop=m.scrollHeight;
}
function fmtTime(ts){ var d=new Date(ts); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function updateStatusDisplay(){
  var bar=document.getElementById('user-bar');
  if(!bar) return;
  var now=Date.now();
  var names=Object.keys(userStates);
  var html='';
  for(var i=0;i<names.length;i++){
    var n=names[i];
    if(n===myName) continue;
    var st=userStates[n];
    var v=st.visible===true;
    if(!v&&st.leftAt&&(now-st.leftAt>600000)) continue;
    html+='<span class="user-item '+(v?'online':'offline')+'">'+escapeHtml(n)+'</span>';
  }
  bar.innerHTML=html;
}

// 改名：更新本地昵称 + 同步腾讯云IM profile + 存档一条系统消息
function closeOverlay(id){ document.getElementById(id).classList.remove('show'); }
function showRenameModal(){ document.getElementById('rename-input').value=myName; document.getElementById('rename-overlay').classList.add('show'); }
function doRename(){
  var newName=document.getElementById('rename-input').value.trim();
  if(!newName){ showToast('昵称不能为空'); return; }
  var oldName=myName;
  if(currentRoomId){ insertSystem(oldName+' 改名为 '+newName); }
  myName=newName;
  try{ localStorage.setItem('xchat_name',newName); }catch(e){}
  if(oldName&&userStates[oldName]){ userStates[newName]=userStates[oldName]; delete userStates[oldName]; }
  // 同步腾讯云IM 昵称，让在线列表/新消息显示新昵称
  if(tim){ try{ tim.updateMyProfile({ nick: newName }).catch(function(){}); }catch(e){} }
  updateStatusDisplay();
  closeOverlay('rename-overlay');
}

function openImgViewer(src){
  document.getElementById('img-viewer-img').src=src;
  document.getElementById('img-viewer').classList.add('show');
}
function closeImgViewer(){ document.getElementById('img-viewer').classList.remove('show'); }
document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeImgViewer(); });

// ---- 表情（保留）----
var WECHAT_EMOJIS=[{name:'微笑',cat:'face',path:'face/微笑.png'},{name:'撇嘴',cat:'face',path:'face/撇嘴.png'},{name:'色',cat:'face',path:'face/色.png'},{name:'得意',cat:'face',path:'face/得意.png'},{name:'流泪',cat:'face',path:'face/流泪.png'},{name:'害羞',cat:'face',path:'face/害羞.png'},{name:'闭嘴',cat:'face',path:'face/闭嘴.png'},{name:'睡',cat:'face',path:'face/睡.png'},{name:'大哭',cat:'face',path:'face/大哭.png'},{name:'尴尬',cat:'face',path:'face/尴尬.png'},{name:'发怒',cat:'face',path:'face/发怒.png'},{name:'调皮',cat:'face',path:'face/调皮.png'},{name:'呲牙',cat:'face',path:'face/呲牙.png'},{name:'惊讶',cat:'face',path:'face/惊讶.png'},{name:'难过',cat:'face',path:'face/难过.png'},{name:'抓狂',cat:'face',path:'face/抓狂.png'},{name:'吐',cat:'face',path:'face/吐.png'},{name:'偷笑',cat:'face',path:'face/偷笑.png'},{name:'白眼',cat:'face',path:'face/白眼.png'},{name:'傲慢',cat:'face',path:'face/傲慢.png'},{name:'困',cat:'face',path:'face/困.png'},{name:'惊恐',cat:'face',path:'face/惊恐.png'},{name:'憨笑',cat:'face',path:'face/憨笑.png'},{name:'悠闲',cat:'face',path:'face/悠闲.png'},{name:'咒骂',cat:'face',path:'face/咒骂.png'},{name:'疑问',cat:'face',path:'face/疑问.png'},{name:'嘘',cat:'face',path:'face/嘘.png'},{name:'晕',cat:'face',path:'face/晕.png'},{name:'衰',cat:'face',path:'face/衰.png'},{name:'骷髅',cat:'face',path:'face/骷髅.png'},{name:'敲打',cat:'face',path:'face/敲打.png'},{name:'再见',cat:'face',path:'face/再见.png'},{name:'擦汗',cat:'face',path:'face/擦汗.png'},{name:'抠鼻',cat:'face',path:'face/抠鼻.png'},{name:'鼓掌',cat:'face',path:'face/鼓掌.png'},{name:'坏笑',cat:'face',path:'face/坏笑.png'},{name:'右哼哼',cat:'face',path:'face/右哼哼.png'},{name:'鄙视',cat:'face',path:'face/鄙视.png'},{name:'委屈',cat:'face',path:'face/委屈.png'},{name:'快哭了',cat:'face',path:'face/快哭了.png'},{name:'阴险',cat:'face',path:'face/阴险.png'},{name:'亲亲',cat:'face',path:'face/亲亲.png'},{name:'可怜',cat:'face',path:'face/可怜.png'},{name:'发呆',cat:'face',path:'face/发呆.png'},{name:'翻白眼',cat:'face',path:'face/翻白眼.png'},{name:'汗',cat:'face',path:'face/汗.png'},{name:'好的',cat:'face',path:'face/好的.png'},{name:'嘿哈',cat:'face',path:'face/嘿哈.png'},{name:'机智',cat:'face',path:'face/机智.png'},{name:'加油',cat:'face',path:'face/加油.png'},{name:'奸笑',cat:'face',path:'face/奸笑.png'},{name:'囧',cat:'face',path:'face/囧.png'},{name:'恐惧',cat:'face',path:'face/恐惧.png'},{name:'苦涩',cat:'face',path:'face/苦涩.png'},{name:'裂开',cat:'face',path:'face/裂开.png'},{name:'脸红',cat:'face',path:'face/脸红.png'},{name:'破涕为笑',cat:'face',path:'face/破涕为笑.png'},{name:'让我看看',cat:'face',path:'face/让我看看.png'},{name:'社会社会',cat:'face',path:'face/社会社会.png'},{name:'生病',cat:'face',path:'face/生病.png'},{name:'失望',cat:'face',path:'face/失望.png'},{name:'叹气',cat:'face',path:'face/叹气.png'},{name:'天啊',cat:'face',path:'face/天啊.png'},{name:'哇',cat:'face',path:'face/哇.png'},{name:'旺柴',cat:'face',path:'face/旺柴.png'},{name:'无语',cat:'face',path:'face/无语.png'},{name:'捂脸',cat:'face',path:'face/捂脸.png'},{name:'笑脸',cat:'face',path:'face/笑脸.png'},{name:'耶',cat:'face',path:'face/耶.png'},{name:'愉快',cat:'face',path:'face/愉快.png'},{name:'皱眉',cat:'face',path:'face/皱眉.png'},{name:'666',cat:'face',path:'face/666.png'},{name:'Emm',cat:'face',path:'face/Emm.png'},{name:'吃瓜',cat:'face',path:'face/吃瓜.png'},{name:'打脸',cat:'face',path:'face/打脸.png'},{name:'OK',cat:'gesture',path:'gesture/OK.png'},{name:'抱拳',cat:'gesture',path:'gesture/抱拳.png'},{name:'勾引',cat:'gesture',path:'gesture/勾引.png'},{name:'合十',cat:'gesture',path:'gesture/合十.png'},{name:'强',cat:'gesture',path:'gesture/强.png'},{name:'拳头',cat:'gesture',path:'gesture/拳头.png'},{name:'弱',cat:'gesture',path:'gesture/弱.png'},{name:'胜利',cat:'gesture',path:'gesture/胜利.png'},{name:'握手',cat:'gesture',path:'gesture/握手.png'},{name:'拥抱',cat:'gesture',path:'gesture/拥抱.png'},{name:'猪头',cat:'animal',path:'animal/猪头.png'},{name:'跳跳',cat:'animal',path:'animal/跳跳.png'},{name:'发抖',cat:'animal',path:'animal/发抖.png'},{name:'转圈',cat:'animal',path:'animal/转圈.png'},{name:'庆祝',cat:'blessing',path:'blessing/庆祝.png'},{name:'红包',cat:'blessing',path:'blessing/红包.png'},{name:'烟花',cat:'blessing',path:'blessing/烟花.png'},{name:'爆竹',cat:'blessing',path:'blessing/爆竹.png'},{name:'發',cat:'blessing',path:'blessing/發.png'},{name:'福',cat:'blessing',path:'blessing/福.png'},{name:'礼物',cat:'blessing',path:'blessing/礼物.png'},{name:'爱心',cat:'other',path:'other/爱心.png'},{name:'啤酒',cat:'other',path:'other/啤酒.png'},{name:'蛋糕',cat:'other',path:'other/蛋糕.png'},{name:'太阳',cat:'other',path:'other/太阳.png'},{name:'炸弹',cat:'other',path:'other/炸弹.png'},{name:'玫瑰',cat:'other',path:'other/玫瑰.png'},{name:'咖啡',cat:'other',path:'other/咖啡.png'},{name:'嘴唇',cat:'other',path:'other/嘴唇.png'},{name:'心碎',cat:'other',path:'other/心碎.png'},{name:'月亮',cat:'other',path:'other/月亮.png'},{name:'便便',cat:'other',path:'other/便便.png'},{name:'菜刀',cat:'other',path:'other/菜刀.png'},{name:'凋谢',cat:'other',path:'other/凋谢.png'}];
var currentEmojiTab='basic';
function toggleEmojiPanel(){
  var p=document.getElementById('emoji-panel');
  if(p.style.display==='none'||p.style.display===''){ p.style.display='block'; renderRecentEmojis(); renderEmojiGrid(); }
  else { p.style.display='none'; }
}
document.addEventListener('click',function(e){
  var p=document.getElementById('emoji-panel');
  if(!p||p.style.display==='none') return;
  if(p.contains(e.target)) return;
  if(e.target.id==='emoji-btn') return;
  p.style.display='none';
});
function showEmojiTab(tab){
  currentEmojiTab=tab;
  var tabs=document.querySelectorAll('.emoji-tab');
  tabs.forEach(function(t){ t.classList.remove('active'); });
  tabs[tab==='basic'?0:1].classList.add('active');
  renderRecentEmojis();
  renderEmojiGrid();
}
function renderEmojiGrid(){
  var grid=document.getElementById('emoji-grid');
  if(!grid) return;
  grid.innerHTML='';
  if(currentEmojiTab==='basic'){
    WECHAT_EMOJIS.forEach(function(e){
      var d=document.createElement('div'); d.className='emoji-item';
      var img=document.createElement('img');
      img.src=wechatEmojiUrl(e);
      img.alt=e.name;
      img.style.cssText='width:28px;height:28px;object-fit:contain;display:inline-block;';
      d.appendChild(img);
      d.title=e.name;
      d.onclick=function(){ sendEmoji(e.name); };
      grid.appendChild(d);
    });
  } else {
    var customs=getCustomEmojis();
    if(!customs.length){
      grid.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#666;font-size:13px;padding:20px 0">暂无自定义表情，点右上角 + 上传</div>';
    } else {
      customs.forEach(function(src,i){
        var d=document.createElement('div'); d.className='emoji-item'; d.style.position='relative';
        var img=document.createElement('img'); img.src=src; img.style.cssText='width:28px;height:28px;object-fit:contain;border-radius:4px;';
        d.appendChild(img);
        d.onclick=function(){ sendEmoji(src); };
        var del=document.createElement('span'); del.style.cssText='position:absolute;top:0;right:0;font-size:10px;color:#ef4444;cursor:pointer;display:none'; del.textContent='\u00d7';
        d.onmouseenter=function(){ del.style.display='block'; };
        d.onmouseleave=function(){ del.style.display='none'; };
        del.onclick=function(ev){ ev.stopPropagation(); deleteCustomEmoji(i); };
        d.appendChild(del);
        grid.appendChild(d);
      });
    }
  }
}
function sendEmoji(emoji){
  if(!currentRoomId) return;
  var isImg=emoji.indexOf('data:image')===0;
  var isWechat=!isImg&&WECHAT_EMOJIS.some(function(e){ return e.name===emoji; });
  if(isWechat){
    var wechat=WECHAT_EMOJIS.find(function(e){ return e.name===emoji; });
    var localUrl=wechatEmojiUrl(wechat);
    fetch(localUrl).then(function(r){ return r.blob(); }).then(function(blob){
      var reader=new FileReader();
      reader.onload=function(){ doSendEmoji(emoji,reader.result); };
      reader.readAsDataURL(blob);
    }).catch(function(){ doSendEmoji(emoji,localUrl); });
  } else {
    doSendEmoji(emoji,isImg?emoji:null);
  }
}
function doSendEmoji(emoji,img){
  if(!currentRoomId) return;
  if(img){
    // 图片表情：走"图片上传 + IM 广播"
    compressImage(img, 64, 0.85).then(function(small){
      optimisticSend('', small);
      doSendChat('', small).catch(function(e){ removeOptimistic(); showToast('发送失败：'+(e&&e.message||e)); });
    });
  } else {
    optimisticSend(emoji, null);
    doSendChat(emoji, null).catch(function(e){ removeOptimistic(); showToast('发送失败：'+(e&&e.message||e)); });
  }
  pushRecentEmoji(emoji);
  renderRecentEmojis();
  document.getElementById('emoji-panel').style.display='none';
}
function getCustomEmojis(){
  try{ return JSON.parse(localStorage.getItem('xchat_custom_emojis')||'[]'); }catch(e){ return []; }
}
function saveCustomEmojis(list){
  try{ localStorage.setItem('xchat_custom_emojis',JSON.stringify(list)); }catch(e){ showToast('存储空间不足，无法保存表情'); }
}
function handleEmojiUpload(input){
  var file=input.files&&input.files[0];
  if(!file) return;
  if(file.size>500000){ showToast('表情图片不能超过500KB'); input.value=''; return; }
  var reader=new FileReader();
  reader.onload=function(ev){
    var dataUrl=ev.target.result;
    var img=new Image();
    img.onload=function(){
      var canvas=document.createElement('canvas');
      var size=64;
      canvas.width=size; canvas.height=size;
      var ctx=canvas.getContext('2d');
      var scale=Math.min(size/img.width,size/img.height);
      var w=img.width*scale, h=img.height*scale;
      ctx.drawImage(img,(size-w)/2,(size-h)/2,w,h);
      var small=canvas.toDataURL('image/png');
      var list=getCustomEmojis();
      list.push(small);
      saveCustomEmojis(list);
      renderEmojiGrid();
      showToast('表情已添加');
    };
    img.src=dataUrl;
  };
  reader.readAsDataURL(file);
  input.value='';
}
function deleteCustomEmoji(index){
  var list=getCustomEmojis();
  list.splice(index,1);
  saveCustomEmojis(list);
  renderEmojiGrid();
}
function getRecentEmojis(){
  try{ return JSON.parse(localStorage.getItem('xchat_recent_emojis')||'[]'); }catch(e){ return []; }
}
function pushRecentEmoji(emoji){
  var list=getRecentEmojis();
  list=list.filter(function(e){ return e!==emoji; });
  list.unshift(emoji);
  if(list.length>10) list=list.slice(0,10);
  try{ localStorage.setItem('xchat_recent_emojis',JSON.stringify(list)); }catch(e){}
}
function renderRecentEmojis(){
  var wrap=document.getElementById('emoji-recent');
  var grid=document.getElementById('emoji-recent-grid');
  if(!wrap||!grid) return;
  if(currentEmojiTab!=='basic'){ wrap.style.display='none'; return; }
  var list=getRecentEmojis();
  grid.innerHTML='';
  if(!list.length){ wrap.style.display='none'; return; }
  wrap.style.display='block';
  list.forEach(function(name){
    var d=document.createElement('div'); d.className='emoji-item';
    var wechat=findWechatEmoji(name);
    var img=document.createElement('img');
    if(wechat){ img.src=wechatEmojiUrl(wechat); }
    else if(name.indexOf('data:image')===0){ img.src=name; }
    else { img=twemojiImg(name,28); }
    img.alt=name;
    img.style.cssText='width:28px;height:28px;object-fit:contain;display:inline-block;';
    d.appendChild(img);
    d.title=name;
    d.onclick=function(){ sendEmoji(name); };
    grid.appendChild(d);
  });
}
function isSingleEmoji(text){
  if(!text) return false;
  var trimmed=text.trim();
  if(!trimmed) return false;
  var codePoints=Array.from(trimmed);
  if(codePoints.length>2) return false;
  return codePoints.every(function(c){
    var cp=c.codePointAt(0);
    return (cp>=0x1F000&&cp<=0x1FAFF)||(cp>=0x2600&&cp<=0x27BF)||(cp>=0x2B00&&cp<=0x2BFF)||(cp>=0x1F1E6&&cp<=0x1F1FF)||cp===0x200D||cp===0xFE0F||cp===0x20E3;
  });
}
function twemojiImg(emoji,size){
  var img=document.createElement('img');
  var codes=Array.from(emoji).map(function(c){ return c.codePointAt(0).toString(16); }).join('-');
  img.src='https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/'+codes+'.png';
  img.style.cssText='width:'+size+'px;height:'+size+'px;object-fit:contain;display:inline-block;vertical-align:middle;';
  img.alt=emoji;
  img.onerror=function(){ var span=document.createElement('span'); span.textContent=emoji; span.style.cssText='font-size:'+size+'px;vertical-align:middle;'; img.parentNode.replaceChild(span,img); };
  return img;
}
// 计算当前站点子路径基址（兼容 Gitee Pages 子路径与根路径）
function baseDir(){
  var p=location.pathname;
  var i=p.lastIndexOf('/');
  if(i<0) return '/';
  return p.slice(0,i+1);
}
function assetPath(p){
  var b=baseDir();
  if(b==='/') return '/'+p.replace(/^\//,'');
  return b+p.replace(/^\//,'');
}
function wechatEmojiUrl(emoji){
  return assetPath('emojis/'+emoji.path.split('/').map(encodeURIComponent).join('/'));
}
function findWechatEmoji(name){
  for(var i=0;i<WECHAT_EMOJIS.length;i++){
    if(WECHAT_EMOJIS[i].name===name) return WECHAT_EMOJIS[i];
  }
  return null;
}
function showToast(msg){
  var t=document.getElementById('error-toast');
  t.textContent=msg; t.style.display='block';
  setTimeout(function(){ t.style.display='none'; },3000);
}

// 等 supabase-js 与 TIM SDK 都加载完成后初始化
var __bootTries = 0;
function bootWhenReady(){
  __bootTries++;
  if(window.supabase && window.TIM){
    try { supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); }
    catch(e){ showToast('聊天服务初始化失败'); return; }
    startRoom();
  } else if(__bootTries > 200){
    showToast('聊天服务加载失败，请检查网络后刷新');
  } else {
    setTimeout(bootWhenReady, 100);
  }
}
function startRoom(){
  var path=location.pathname.replace('/','').trim();
  var roomId=(path&&/^[0-9]+$/.test(path))?path:'666';
  joinRoom(roomId);
}

window.addEventListener('load',function(){
  bootWhenReady();
  // ---- PWA: 注册 Service Worker ----
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(function(e){ console.log('SW register failed',e); });
  }
});
