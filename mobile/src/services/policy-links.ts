import { publicPolicyUrl } from "./public-policy-url"

// Expo substitutes these explicit references when bundling. Do not infer legal
// URLs from the API origin or append account, device or household identifiers.
export const policyLinks = {
  privacy: publicPolicyUrl(process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL),
  terms: publicPolicyUrl(process.env.EXPO_PUBLIC_TERMS_URL),
}
export const subscriptionPoliciesAvailable = Boolean(policyLinks.privacy && policyLinks.terms)
