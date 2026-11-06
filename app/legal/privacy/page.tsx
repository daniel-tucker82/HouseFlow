import type { Metadata } from "next"
import { PolicyPage } from "@/components/policy-page"
import { cyntchContactEmail, cyntchContactHref } from "@/lib/public-contact"

export const metadata: Metadata = {
  title: "Privacy policy | Cyntch",
  description: "How Cyntch handles account, household, device and subscription information, and how to contact us about your data.",
  alternates: { canonical: "https://www.cyntch.com/legal/privacy" },
}

export default function PrivacyPage() {
  return <PolicyPage title="Privacy policy" intro="Cyntch helps households organise shared tasks and routines. This policy explains the information used to provide Cyntch’s website and mobile applications.">
    <section aria-labelledby="operator">
      <h2 id="operator">Who we are</h2>
      <p>Cyntch is operated by Aspyre Pty Ltd (ABN 93 689 591 740), Australia. For privacy questions, requests or complaints, email <a href={cyntchContactHref}>{cyntchContactEmail}</a>.</p>
    </section>
    <section aria-labelledby="information">
      <h2 id="information">Information we collect and why</h2>
      <ul>
        <li><strong>Account information:</strong> sign-in identifiers, email addresses, names and profile information supplied through our authentication provider. We use this to identify you, secure your account and manage access.</li>
        <li><strong>Household information:</strong> household and member names, profile colours, roles, invitations, tasks, rewards, routines, schedules, assignments and completion history. We use this to display and coordinate your household’s activities.</li>
        <li><strong>Device and notification information:</strong> installation and session identifiers, device platform, notification permission and preference settings, push tokens, delivery records and notification history. We use these to synchronise devices and send the notifications you select.</li>
        <li><strong>Subscription information:</strong> billing customer and transaction identifiers, purchased products, subscription status and payment records. We use these to provide paid access, restore purchases and handle billing. Payment providers handle card details; Cyntch does not store full payment card numbers.</li>
        <li><strong>Service and support information:</strong> network information such as IP addresses, request and error logs, security events and messages you send us. We use this to run, protect and troubleshoot Cyntch and respond to you.</li>
      </ul>
      <p>Information comes from you, other authorised household members, your device and the providers that support sign-in, payments and notifications. You do not need to put sensitive personal information in task or routine descriptions.</p>
    </section>
    <section aria-labelledby="sharing">
      <h2 id="sharing">Who can see or process information</h2>
      <p>Cyntch is a shared household service. Other authorised members can see household information relevant to their access. Parents can manage members and routines. People using an unlocked shared device may see the information available on that device.</p>
      <p>We use service providers to operate Cyntch:</p>
      <ul>
        <li>Clerk provides sign-in and account authentication.</li>
        <li>Hosting and database services, including Vercel and Railway, operate the website, application services and data storage.</li>
        <li>Stripe processes website billing. Apple, Google Play and RevenueCat process or verify mobile subscriptions where those purchases are available.</li>
        <li>Expo and Apple or Google notification services process push tokens, routing information and notification content to deliver enabled mobile notifications.</li>
      </ul>
      <p>Providers receive information needed for their functions and may keep their own security, transaction and operational records. We may also disclose information when required by law or to investigate misuse and protect people or the service. Cyntch does not sell household information or use it for targeted advertising.</p>
      <p>Providers operate internationally, including in the United States, so information may be processed outside Australia. Their locations and processing arrangements can change. Contact us for information about the providers handling your data.</p>
    </section>
    <section aria-labelledby="children">
      <h2 id="children">Children and family devices</h2>
      <p>A parent or guardian can create a child’s household profile without an email address. A nickname is sufficient. That profile contains its name, colour, household role, assignments and task activity; it does not create a separate sign-in. Children can update tasks using a parent’s device or a shared family device.</p>
      <p>Parents should choose what information to enter and who joins the household, supervise use and use parent access controls on shared devices. Kiosk mode restricts actions inside Cyntch; it does not lock the device or prevent access to other apps. Contact us to request access to, correction or deletion of a child’s information.</p>
    </section>
    <section aria-labelledby="device">
      <h2 id="device">Storage, security and notifications</h2>
      <p>The mobile app keeps household data and pending task changes on the device so tasks can be updated offline. Pending changes are sent when a connection is available. The website uses cookies and browser storage for sign-in and application functions. Clearing storage can remove changes that have not synchronised.</p>
      <p>We use encrypted network connections, access checks and device secure storage for sign-in and recovery credentials. Access is limited according to account and household permissions. Device security and the people who can unlock your device also affect the privacy of locally stored information.</p>
      <p>Notifications are optional. You can choose notification types and family members independently on each device, change preview detail, and change permission in device settings. Notification previews can appear on a lock screen and may include task, routine or member names if details are enabled.</p>
    </section>
    <section aria-labelledby="retention">
      <h2 id="retention">Keeping and deleting information</h2>
      <p>Household records remain available until you or an authorised member remove them, or an account or household deletion removes them. Cancelling a subscription does not itself erase household history.</p>
      <p>You can request account deletion in the mobile app’s Settings, or by emailing <a href={cyntchContactHref}>{cyntchContactEmail}</a>. You do not need the app to email a request. We verify ownership and confirm what should happen to any household you own before accepting deletion.</p>
      <p>Account deletion removes your sign-in, memberships, preferences, notification information and authored tasks and routines. Household deletion removes that household’s shared content. Other members’ own content is preserved where their household continues. A profile without its own sign-in is removed when it is no longer used by another household.</p>
      <p>Minimal transaction, security and deletion records are retained to prevent duplicate billing, replayed requests or restoration of deleted accounts, and to meet applicable financial and legal obligations. These records can outlast account deletion; they are not a continuing copy of your household’s task content. Payment and other service providers may also retain records for their legal and security responsibilities. Contact us about the records relevant to a particular request.</p>
      <p>Deleting Cyntch or your account does not cancel Apple or Google Play subscription renewals. Manage those subscriptions through the store that bills you.</p>
    </section>
    <section aria-labelledby="choices">
      <h2 id="choices">Your requests and complaints</h2>
      <p>You can ask us to explain our data handling, give you access to information, correct it or delete it. Depending on applicable law, you may also have rights to receive a copy, restrict or object to processing, or withdraw consent. We may need to verify your identity or authority over a child’s profile. Do not email passwords, sign-in codes or payment card details.</p>
      <p>Email <a href={cyntchContactHref}>{cyntchContactEmail}</a> with your request or complaint. We will investigate and respond, explaining any information we need or legal reason that prevents us fulfilling a request. You can also contact the privacy regulator where you live; in Australia, this is the <a href="https://www.oaic.gov.au/privacy/privacy-complaints">Office of the Australian Information Commissioner</a>.</p>
      <p>We update this page when our practices change and show the revision date above. Where a change requires notice or consent, we will provide that before applying the change.</p>
    </section>
  </PolicyPage>
}
