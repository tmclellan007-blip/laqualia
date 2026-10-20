// Matrice des permissions : une seule source de vérité, appliquée côté serveur
// et exposée en lecture seule à l'écran « Rôles et permissions ».

export const ROLES = ["member", "admin", "owner"]; // ordre croissant
export const ROLE_LABELS = { member: "Membre", admin: "Administrateur d'établissement", owner: "Propriétaire d'établissement", platform: "Administrateur de la plateforme" };
export const FUNCTIONS = { reception: "Réception", tsa: "Technicien(ne) en santé animale (TSA)", veterinarian: "Vétérinaire", manager: "Gestion", other: "Autre" };
const RANK = { member: 1, admin: 2, owner: 3, platform: 4 };

// Niveau minimal requis pour chaque action dans un établissement.
export const MATRIX = [
  { action: "org.read", label: "Voir l'établissement et sa propre appartenance", min: "member" },
  { action: "org.leave", label: "Quitter l'établissement", min: "member" },
  { action: "org.update", label: "Modifier le nom, la ville et le logo de l'établissement", min: "admin" },
  { action: "members.read", label: "Voir la liste des membres et leurs statuts", min: "admin" },
  { action: "invitations.read", label: "Voir les invitations en attente", min: "admin" },
  { action: "members.invite", label: "Inviter un membre ou un administrateur", min: "admin" },
  { action: "members.invite_owner", label: "Inviter un propriétaire", min: "owner" },
  { action: "invitations.revoke", label: "Révoquer une invitation", min: "admin" },
  { action: "members.update_function", label: "Modifier la fonction d'un membre", min: "admin" },
  { action: "members.update_role", label: "Changer le rôle d'un membre ou d'un administrateur", min: "admin" },
  { action: "members.manage_owner", label: "Changer le rôle, désactiver ou retirer un propriétaire", min: "owner" },
  { action: "members.disable", label: "Désactiver ou réactiver un membre", min: "admin" },
  { action: "members.remove", label: "Retirer un membre de l'établissement", min: "admin" },
  { action: "ownership.transfer", label: "Transférer la propriété", min: "owner" },
  { action: "portal.use", label: "Utiliser le portail : Réception, Équipe technique (TSA) et tableau de bord", min: "member" },
  { action: "access_codes.read", label: "Voir et copier les codes d'accès de l'établissement", min: "admin" },
  { action: "access_codes.manage", label: "Générer, renouveler ou révoquer un code d'accès", min: "admin" },
  { action: "audit.read", label: "Consulter le journal des changements", min: "admin" },
  { action: "platform.orgs", label: "Créer et voir tous les établissements", min: "platform" },
  { action: "platform.recovery", label: "Créer un lien de récupération d'accès", min: "platform" },
  { action: "platform.agent_config", label: "Configurer l'agent (page Admin, commune à tous les établissements)", min: "platform" },
];
const MIN = Object.fromEntries(MATRIX.map((m) => [m.action, m.min]));

export function can(level, action) {
  const min = MIN[action];
  if (!min) return false; // action inconnue : refusée
  return (RANK[level] || 0) >= RANK[min];
}
export const permissionsFor = (level) => MATRIX.filter((m) => can(level, m.action)).map((m) => m.action);

// Règles sur la personne visée (en plus de la matrice) : renvoie null si permis, sinon un message.
export function checkTarget(level, actorUserId, target, newRole) {
  if (!target) return "Membre introuvable dans cet établissement.";
  const targetIsOwner = target.role === "owner";
  if ((targetIsOwner || newRole === "owner") && !can(level, "members.manage_owner"))
    return "Seul un propriétaire peut modifier un propriétaire ou nommer un nouveau propriétaire.";
  if (newRole && !ROLES.includes(newRole)) return "Rôle inconnu.";
  return null;
}
