/**
 * Cloudflare Worker - Formulaire de Contact La Qualia
 * Traite les soumissions de formulaire et envoie les emails via SendGrid
 */

const EMAIL_ENVOYEUR = 'info@laqualia.com';
const EMAIL_ADMIN = 'info@laqualia.com';

/**
 * Traiter les requêtes
 */
export default {
  async fetch(request, env, ctx) {
    // CORS pour accepter les requêtes du formulaire
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Accepter uniquement les POST
    if (request.method !== 'POST') {
      return réponseJSON({ erreur: 'Méthode non autorisée' }, 405);
    }

    try {
      // Parser les données du formulaire
      const formData = await request.formData();
      
      // Extraire et valider les champs
      const prenom = (formData.get('prenom') || '').trim();
      const nom = (formData.get('nom') || '').trim();
      const email = (formData.get('email') || '').trim();
      const telephone = (formData.get('telephone') || '').trim();
      const sujet = (formData.get('sujet') || '').trim();
      const message = (formData.get('message') || '').trim();

      // Validation des champs obligatoires
      const erreurs = validerFormulaire(prenom, email, message);
      if (erreurs.length > 0) {
        return réponseJSON(
          { succes: false, message: erreurs.join(' ') },
          400
        );
      }

      // Valider l'email
      if (!validerEmail(email)) {
        return réponseJSON(
          { succes: false, message: 'Adresse email invalide.' },
          400
        );
      }

      // Préparer et envoyer les emails
      const sendgridKey = env.SENDGRID_API_KEY;
      if (!sendgridKey) {
        console.error('SENDGRID_API_KEY non configurée');
        return réponseJSON(
          { succes: false, message: 'Erreur de configuration serveur.' },
          500
        );
      }

      // Envoyer l'email à l'admin
      await envoyerEmailAdmin(sendgridKey, {
        prenom,
        nom,
        email,
        telephone,
        sujet,
        message,
      });

      // Envoyer l'email de confirmation au client
      await envoyerEmailClient(sendgridKey, {
        prenom,
        email,
        message,
      });

      return réponseJSON(
        {
          succes: true,
          message: `Merci ${prenom} ! Nous vous contacterons très bientôt.`,
        },
        200
      );

    } catch (erreur) {
      console.error('Erreur:', erreur);
      return réponseJSON(
        { succes: false, message: 'Une erreur est survenue. Veuillez réessayer.' },
        500
      );
    }
  },
};

/**
 * Valider les champs obligatoires
 */
function validerFormulaire(prenom, email, message) {
  const erreurs = [];

  if (!prenom) {
    erreurs.push('Le prénom est obligatoire.');
  }

  if (!email) {
    erreurs.push('L\'email est obligatoire.');
  }

  if (!message) {
    erreurs.push('Le message est obligatoire.');
  }

  return erreurs;
}

/**
 * Valider le format email
 */
function validerEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

/**
 * Envoyer email à l'admin
 */
async function envoyerEmailAdmin(sendgridKey, data) {
  const { prenom, nom, email, telephone, sujet, message } = data;

  const corps = `
Bonjour,

Vous avez reçu un nouveau message via le formulaire de contact La Qualia.

---

INFORMATIONS DU CLIENT
Prénom : ${prenom}
Nom : ${nom || 'Non fourni'}
Email : ${email}
Téléphone : ${telephone || 'Non fourni'}
Sujet : ${sujet || 'Non fourni'}

MESSAGE
${message}

---

Pour répondre, écrivez directement à ${email}

Cet email a été envoyé automatiquement par votre formulaire de contact La Qualia.
  `;

  const payload = {
    personalizations: [
      {
        to: [{ email: EMAIL_ADMIN }],
        subject: `[La Qualia] Nouveau message de ${prenom}`,
      },
    ],
    from: { email: EMAIL_ENVOYEUR, name: 'La Qualia' },
    content: [
      {
        type: 'text/plain',
        value: corps,
      },
    ],
    reply_to: { email },
  };

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sendgridKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`SendGrid error: ${response.status}`);
  }
}

/**
 * Envoyer email de confirmation au client
 */
async function envoyerEmailClient(sendgridKey, data) {
  const { prenom, email, message } = data;

  const corps = `
Bonjour ${prenom},

Merci de nous avoir contactés ! Nous avons bien reçu votre message et nous vous répondrons dans les 24 heures.

---

VOS INFORMATIONS
Nous avons enregistré :
• Prénom : ${prenom}
• Email : ${email}

Votre message : 
${message}

---

L'équipe de La Qualia
info@laqualia.com
Saguenay–Lac-Saint-Jean, Québec

P.S. Si vous ne recevez pas notre réponse dans 24h, vérifiez votre dossier spam ou contactez-nous directement.
  `;

  const payload = {
    personalizations: [
      {
        to: [{ email }],
        subject: 'Merci de nous avoir contactés - La Qualia',
      },
    ],
    from: { email: EMAIL_ENVOYEUR, name: 'La Qualia' },
    content: [
      {
        type: 'text/plain',
        value: corps,
      },
    ],
    reply_to: { email: EMAIL_ADMIN },
  };

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sendgridKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`SendGrid error: ${response.status}`);
  }
}

/**
 * Réponse JSON avec headers CORS
 */
function réponseJSON(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
