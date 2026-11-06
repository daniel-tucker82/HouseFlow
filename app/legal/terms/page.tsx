import type { Metadata } from "next"
import Link from "next/link"
import { PolicyPage } from "@/components/policy-page"
import { cyntchContactEmail, cyntchContactHref } from "@/lib/public-contact"

export const metadata: Metadata = {
  title: "Terms of use | Cyntch",
  description: "Terms for using Cyntch, managing a household and purchasing or cancelling a subscription.",
  alternates: { canonical: "https://www.cyntch.com/legal/terms" },
}

export default function TermsPage() {
  return <PolicyPage title="Terms of use" intro="These terms apply to Cyntch’s website and mobile applications, provided by Aspyre Pty Ltd (ABN 93 689 591 740), Australia.">
    <section aria-labelledby="using">
      <h2 id="using">Using Cyntch</h2>
      <p>Cyntch helps your household organise tasks, routines and rewards. Keep your sign-in secure and provide accurate account information. Only invite people you are authorised to include, and only add a child’s information if you are their parent or guardian or have the necessary permission.</p>
      <p>Parents are responsible for supervising children’s use and choosing appropriate tasks and rewards. A parent or guardian manages a child’s profile without an email address. Kiosk mode restricts controls within Cyntch and does not prevent someone leaving the app or using other device functions.</p>
      <p>Do not use Cyntch unlawfully, harass others, upload content you have no right to use, interfere with the service or attempt to access another person’s account or household without permission.</p>
    </section>
    <section aria-labelledby="content">
      <h2 id="content">Your household content</h2>
      <p>You retain your rights in content you provide. You allow us and our service providers to store, process and display it as needed to operate Cyntch for your household. Authorised household members may view or change shared content according to their roles.</p>
      <p>Our <Link href="/legal/privacy">privacy policy</Link> explains data handling, device storage and deletion. Before removing content or a household, consider how this affects other members. Accepted account deletion is permanent.</p>
    </section>
    <section aria-labelledby="subscription">
      <h2 id="subscription">Free access and subscriptions</h2>
      <p>Cyntch offers free features and paid household access. Available features, limits, price, currency and billing period are shown before purchase. Paid access applies to the household selected at purchase; it is not automatically a subscription for every household you join.</p>
      <p>Subscriptions renew automatically for the displayed billing period until cancelled through the provider that bills you. Check the purchase confirmation for the renewal date and cancellation deadline. You can manage website subscriptions through Cyntch’s billing settings, or mobile subscriptions through <a href="https://apps.apple.com/account/subscriptions">Apple</a> or <a href="https://play.google.com/store/account/subscriptions">Google Play</a>.</p>
      <p>Cancellation stops future renewals. Access normally continues for the paid period, subject to refunds, payment reversals and the billing provider’s terms. Uninstalling the app or deleting your Cyntch account does not cancel a store subscription. Restore purchases in the app if you need to recover eligible store access for the original household.</p>
      <p>Refund requests are handled by the provider that charged you, subject to applicable consumer rights. Contact us if you need help identifying that provider. We will communicate price or subscription changes as required by law and the billing provider’s rules.</p>
    </section>
    <section aria-labelledby="operation">
      <h2 id="operation">Availability and changes</h2>
      <p>Cyntch needs an internet connection for sign-in, household administration, purchases and synchronisation. Offline task updates are saved on the device and synchronise when a connection is available. Shared task status can change after synchronisation if another device has made a more recent edit.</p>
      <p>Notification delivery and timing depend on device permissions, connectivity and platform services. Cyntch is not an emergency alarm or a substitute for supervising a child. We aim to keep the service reliable, but maintenance, faults and third-party outages can interrupt access.</p>
      <p>We may update the service or restrict access where reasonably necessary to protect accounts, investigate misuse or meet legal requirements. We will explain material changes or restrictions where practicable, and preserve any rights you have to a remedy under applicable law.</p>
    </section>
    <section aria-labelledby="rights">
      <h2 id="rights">Your consumer rights</h2>
      <p>Nothing in these terms excludes, restricts or modifies a consumer guarantee or other right that cannot lawfully be excluded, including under the Australian Consumer Law. Where the service fails to meet an applicable guarantee, you may be entitled to a remedy such as a correction, cancellation, refund or compensation.</p>
      <p>Apple and Google Play purchases are also subject to the relevant store’s terms. The <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/">Apple Standard Licensed Application End User License Agreement</a> applies to the iOS application where applicable.</p>
    </section>
    <section aria-labelledby="contact">
      <h2 id="contact">Contact and updates</h2>
      <p>For help, billing questions or a complaint, email <a href={cyntchContactHref}>{cyntchContactEmail}</a>. Tell us what happened without including passwords or payment card details.</p>
      <p>We may revise these terms as Cyntch changes. The date above identifies this version. We will give notice of material changes and obtain agreement where required; a revision does not remove rights that have already arisen.</p>
    </section>
  </PolicyPage>
}
