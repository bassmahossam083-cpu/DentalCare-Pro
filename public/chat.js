const chatForm=document.querySelector('#chatForm');
const chatMessages=document.querySelector('#chatMessages');
const chatInput=document.querySelector('#chatInput');
const sendBtn=chatForm.querySelector('button[type="submit"]');
let chatLanguage='ar';

function addChat(text,role){
  const node=document.createElement('div');
  node.className='chat-bubble '+role;
  node.textContent=text;
  chatMessages.append(node);
  chatMessages.scrollTop=chatMessages.scrollHeight;
  return node;
}

function setLanguage(lang){
  chatLanguage=lang;
  document.querySelector('#langAr').classList.toggle('active',lang==='ar');
  document.querySelector('#langEn').classList.toggle('active',lang==='en');
  chatInput.placeholder=lang==='ar' ? 'مثال: أشعر بألم مع المشروبات الباردة' : 'Example: I have pain with cold drinks';
}

document.querySelector('#langAr').onclick=()=>setLanguage('ar');
document.querySelector('#langEn').onclick=()=>setLanguage('en');
setLanguage('ar');

chatForm.onsubmit=async e=>{
  e.preventDefault();
  const message=chatInput.value.trim();
  if(!message)return;
  addChat(message,'user');
  chatInput.value='';
  sendBtn.disabled=true;
  const waiting=addChat(chatLanguage==='ar'?'جاري التفكير...':'Thinking...','bot');
  try{
    const response=await fetch('/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message,lang:chatLanguage})
    });
    const data=await response.json();
    waiting.remove();
    addChat(data.answer||data.error||(chatLanguage==='ar'?'تعذر الاتصال بالمساعد':'Assistant unavailable'),'bot');
  }catch{
    waiting.remove();
    addChat(chatLanguage==='ar'?'تعذر الاتصال بالمساعد حاليًا.':'Assistant is currently unavailable.','bot');
  }finally{
    sendBtn.disabled=false;
    chatInput.focus();
  }
};
