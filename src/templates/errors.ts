import { escHtml } from './layout';

export function errorPage(opts: {
  status: 404 | 500;
  title: string;
  heading: string;
  message?: string;
  siteTitle: string;
}): string {
  const message = opts.message
    ? `<p class="mt-2 text-gray-500">${escHtml(opts.message)}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${opts.status} - ${escHtml(opts.title)} - ${escHtml(opts.siteTitle)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen flex items-center justify-center bg-gray-50">
  <div class="text-center">
    <p class="text-6xl font-bold text-gray-300">${opts.status}</p>
    <h1 class="mt-4 text-2xl font-semibold text-gray-700">${escHtml(opts.heading)}</h1>
    ${message}
    <a href="/admin" class="mt-6 inline-block text-indigo-600 hover:underline">Back to Dashboard</a>
  </div>
</body>
</html>`;
}
