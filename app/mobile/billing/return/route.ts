/** No account data, payment links or entitlement decisions on this return page. */
export function GET() {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to Cyntch</title>
<style>body{margin:0;background:#f7f8f5;color:#243e3b;font:1.1rem/1.6 system-ui,sans-serif}main{max-width:32rem;margin:12vh auto;padding:2rem}a{display:inline-block;background:#23685b;color:white;padding:1rem 1.5rem;border-radius:1rem;text-decoration:none}a:focus-visible{outline:3px solid #243e3b;outline-offset:4px}</style></head>
<body><main><h1>Return to Cyntch</h1><p>You can close this page and return to the app. Your household plan updates after the billing provider confirms any changes.</p><a href="cyntch://settings">Open Cyntch</a></main></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" },
  })
}
