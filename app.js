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
const modules={accueil:{title:'L’accueil en clinique',text:'Un exemple de parcours : comprendre les étapes d’accueil, repérer les informations à recueillir et s’exercer à orienter un nouveau client selon les procédures de l’établissement.'},pratiques:{title:'Vos pratiques internes',text:'Un exemple de parcours : retrouver les procédures de votre établissement, comprendre les responsabilités de chaque rôle et vérifier ses connaissances à l’aide de quiz contextualisés.'},situations:{title:'Mises en situation',text:'Un exemple de parcours : pratiquer une conversation à la réception, gérer une demande inhabituelle et identifier le bon moment pour demander l’aide d’un collègue ou du gestionnaire.'}};
document.querySelectorAll('[data-module]').forEach(button=>button.addEventListener('click',()=>{const item=modules[button.dataset.module];document.getElementById('module-title').textContent=item.title;document.getElementById('module-text').textContent=item.text;openDialog(document.getElementById('module-dialog'),button)}));
const examples={accueil:['Où trouver la procédure d’accueil d’un nouveau client ?','L’accompagnant peut vous orienter vers la procédure validée par votre établissement et ses documents de référence.'],rh:['Quelles sont les étapes d’intégration d’un nouvel employé ?','L’accompagnant peut rendre accessibles le parcours d’intégration, les ressources utiles et les responsabilités définies par votre établissement.'],equipe:['Où retrouver une procédure interne pendant mon travail ?','L’accompagnant peut faciliter la recherche dans les ressources de votre établissement et vous orienter vers la procédure pertinente.']};
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
