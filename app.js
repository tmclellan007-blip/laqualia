'use strict';
const menuButton=document.querySelector('.menu-toggle');
const nav=document.getElementById('navigation');
function closeMenu(){nav.classList.remove('is-open');menuButton.setAttribute('aria-expanded','false')}
menuButton.addEventListener('click',()=>{const open=menuButton.getAttribute('aria-expanded')!=='true';menuButton.setAttribute('aria-expanded',String(open));nav.classList.toggle('is-open',open)});
nav.querySelectorAll('a').forEach(link=>link.addEventListener('click',closeMenu));
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu()});
window.matchMedia('(min-width: 901px)').addEventListener('change',event=>{if(event.matches)closeMenu()});
let dialogTrigger=null;
function openDialog(dialog,trigger){document.querySelectorAll('dialog[open]').forEach(d=>d.close());dialogTrigger=trigger;dialog.showModal();closeMenu();}
document.querySelectorAll('[data-contact]').forEach(link=>link.addEventListener('click',()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());closeMenu();}));
document.querySelectorAll('[data-privacy]').forEach(button=>button.addEventListener('click',event=>openDialog(document.getElementById('privacy-dialog'),event.currentTarget)));
document.querySelectorAll('dialog:not(#lq-cookie-dialog)').forEach(dialog=>{dialog.querySelector('.close-dialog').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close()}});dialog.addEventListener('close',()=>{if(!document.querySelector('dialog[open]')&&dialogTrigger?.isConnected)dialogTrigger.focus()})});
const isEN=document.documentElement.lang.startsWith('en');
document.querySelectorAll('[data-lang-switch]').forEach(a=>{const base=a.getAttribute('href');const sync=()=>{a.setAttribute('href',base+location.hash)};a.addEventListener('click',sync);a.addEventListener('focus',sync);a.addEventListener('mouseenter',sync)});
const modules=isEN?{accueil:{title:'Front desk at the clinic',text:'An example learning path: understand the welcome steps, identify the information to collect and practise guiding a new client according to your clinic’s procedures.'},pratiques:{title:'Your internal practices',text:'An example learning path: find your clinic’s procedures, understand each role’s responsibilities and check your knowledge with contextual quizzes.'},situations:{title:'Scenarios',text:'An example learning path: practise a front-desk conversation, handle an unusual request and recognize when to ask a colleague or manager for help.'}}:{accueil:{title:'L’accueil en clinique',text:'Un exemple de parcours : comprendre les étapes d’accueil, repérer les informations à recueillir et s’exercer à orienter un nouveau client selon les procédures de l’établissement.'},pratiques:{title:'Vos pratiques internes',text:'Un exemple de parcours : retrouver les procédures de votre établissement, comprendre les responsabilités de chaque rôle et vérifier ses connaissances à l’aide de quiz contextualisés.'},situations:{title:'Mises en situation',text:'Un exemple de parcours : pratiquer une conversation à la réception, gérer une demande inhabituelle et identifier le bon moment pour demander l’aide d’un collègue ou du gestionnaire.'}};
document.querySelectorAll('[data-module]').forEach(button=>button.addEventListener('click',()=>{const item=modules[button.dataset.module];document.getElementById('module-title').textContent=item.title;document.getElementById('module-text').textContent=item.text;openDialog(document.getElementById('module-dialog'),button)}));
const examples=isEN?{accueil:['Where can I find the procedure for welcoming a new client?','The assistant can point you to the procedure validated by your clinic and its reference documents.'],rh:['What are the steps for onboarding a new employee?','The assistant can make the onboarding path, useful resources and responsibilities defined by your clinic easy to access.'],equipe:['Where can I find an internal procedure while I work?','The assistant can help you search your clinic’s resources and point you to the relevant procedure.']}:{accueil:['Où trouver la procédure d’accueil d’un nouveau client ?','L’accompagnant peut vous orienter vers la procédure validée par votre établissement et ses documents de référence.'],rh:['Quelles sont les étapes d’intégration d’un nouvel employé ?','L’accompagnant peut rendre accessibles le parcours d’intégration, les ressources utiles et les responsabilités définies par votre établissement.'],equipe:['Où retrouver une procédure interne pendant mon travail ?','L’accompagnant peut faciliter la recherche dans les ressources de votre établissement et vous orienter vers la procédure pertinente.']};
document.querySelectorAll('[data-example]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-example]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));const item=examples[button.dataset.example];const bubbles=document.querySelectorAll('.assistant-conversation .bubble');bubbles[0].textContent=item[0];bubbles[1].textContent=item[1]}));
const benefits={efficacite:['Efficacité au travail','Trouver les ressources utiles au bon moment pour faciliter les tâches du quotidien et réduire le temps consacré à chercher l’information.'],competences:['Développement des compétences','Développer ses connaissances et les mettre en pratique avec des formations courtes, des quiz et des mises en situation adaptés à son rôle.'],autonomie:['Autonomie acquise','Disposer de repères clairs et de procédures accessibles pour prendre progressivement en charge ses tâches, tout en sachant quand demander du soutien.'],confiance:['Confiance professionnelle','Consolider ses repères, pratiquer les situations du quotidien et bénéficier d’un encadrement pour renforcer sa confiance dans son travail.'],retention:['Rétention des employés','Soutenir l’intégration, le développement et l’engagement par une expérience d’apprentissage et d’accompagnement qui se poursuit dans le temps.'],bienetre:['Bien-être et satisfaction au travail','Recueillir l’expérience des employés, repérer leurs besoins et ajuster les ressources ainsi que le soutien offert avec les gestionnaires.']};
document.querySelectorAll('[data-benefit]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-benefit]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));const title=document.getElementById('benefit-title'),description=document.getElementById('benefit-description');if(!title||!description)return;const item=benefits[button.dataset.benefit];title.textContent=item[0];description.textContent=item[1]}));
document.querySelectorAll('[data-dimension]').forEach(button=>button.addEventListener('click',()=>{const shown=button.getAttribute('aria-pressed')!=='true';button.setAttribute('aria-pressed',String(shown));document.querySelector(`[data-curve="${button.dataset.dimension}"]`).style.opacity=shown?'1':'0';const areas={bienetre:0,retention:1,competences:2};if(Object.hasOwn(areas,button.dataset.dimension))document.querySelectorAll('.area')[areas[button.dataset.dimension]].style.opacity=shown?'1':'0'}));
document.getElementById('year').textContent=String(new Date().getFullYear());

// Limite la collecte simple : coordonnées décodées seulement après une action.
(() => {
 const contactData = {"email":{"text":[118,122,114,123,126,114,57,117,101,98,121,114,123,123,114,87,123,118,102,98,118,123,126,118,57,116,120,122],"href":[122,118,126,123,99,120,45,118,122,114,123,126,114,57,117,101,98,121,114,123,123,114,87,123,118,102,98,118,123,126,118,57,116,120,122]},"phone":{"text":[35,38,47,58,34,46,39,58,37,33,47,36],"href":[99,114,123,45,60,38,35,38,47,34,46,39,37,33,47,36]}};
 const decode = values => values.map(value => String.fromCharCode(value ^ 23)).join('');
 document.querySelectorAll('[data-reveal-contact]').forEach(button => {
  const value = contactData[button.dataset.revealContact];
  const link = document.getElementById(button.getAttribute('aria-controls'));
  if (!value || !link) return;
  button.addEventListener('click', () => {
   link.textContent = decode(value.text);
   link.href = decode(value.href);
   link.hidden = false;
   button.hidden = true;
   link.focus();
  }, {once:true});
  button.hidden = false;
 });
})();

// Formulaire : envoi sans quitter la page, messages localisés, repli sur l'envoi classique.
(() => {
 const form = document.getElementById('contact-form'); if (!form) return;
 const en = document.documentElement.lang.startsWith('en');
 const T = en
  ? {req:'Please fill in this field.',mail:'Please enter a valid email address (e.g. name@clinic.com).',sending:'Sending…',ok:'Thank you! Your request has been sent. We will get back to you shortly.',err:'Sorry, your request could not be sent. Please try again or use the contact details on this page.',fix:'Please check the highlighted fields.',btn:'Send my request'}
  : {req:'Veuillez remplir ce champ.',mail:'Veuillez saisir une adresse courriel valide (ex. : nom@clinique.com).',sending:'Envoi en cours…',ok:'Merci ! Votre demande a bien été envoyée. Nous vous répondrons sous peu.',err:'Désolé, votre demande n’a pas pu être envoyée. Veuillez réessayer ou utiliser les coordonnées de cette page.',fix:'Veuillez vérifier les champs signalés.',btn:'Envoyer ma demande'};
 const status = document.getElementById('form-status'), btn = form.querySelector('button[type=submit]'), label = btn.querySelector('span');
 const say = (msg, kind) => { status.textContent = msg; status.dataset.kind = kind || ''; };
 const check = field => {
  field.setCustomValidity('');
  if (!field.checkValidity()) field.setCustomValidity(field.validity.valueMissing ? T.req : T.mail);
  field.setAttribute('aria-invalid', String(!field.checkValidity()));
  return field.checkValidity();
 };
 const fields = [...form.querySelectorAll('input:not([type=hidden]):not(.hp),textarea')];
 fields.forEach(f => { f.addEventListener('blur', () => { if (f.value || f.getAttribute('aria-invalid')) check(f); }); f.addEventListener('input', () => { if (f.getAttribute('aria-invalid') === 'true') check(f); }); });
 form.addEventListener('submit', async event => {
  event.preventDefault();
  const bad = fields.filter(f => !check(f));
  if (bad.length) { say(T.fix, 'error'); bad[0].focus(); bad[0].reportValidity(); return; }
  btn.disabled = true; label.textContent = T.sending; say('', '');
  try {
   const res = await fetch(form.action, {method:'POST', body:new FormData(form), headers:{Accept:'application/json'}});
   if (!res.ok) throw new Error(res.status);
   form.reset(); say(T.ok, 'ok'); status.focus();
  } catch (e) { say(T.err, 'error'); }
  btn.disabled = false; label.textContent = T.btn;
 });
})();
