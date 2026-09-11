// Local Tailwind build — replaces the Play CDN so the product renders with
// zero CDN dependency for CSS. Rebuild after editing page classes:
//   npm run css        (one shot, minified)
//   npm run css:watch  (during design work)
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['../*.html', '../api-bridge.js'],
  theme: {
    extend: {
      fontFamily: { grotesk: ['"Cabinet Grotesk"', 'Outfit', 'sans-serif'] },
      colors: {
        ink: '#111110',
        bone: '#FFF8EC',
        lime: '#D8FF3E',
        tang: '#FF5C28',
        sky: '#7AB8FF',
        card: '#151412',
      },
    },
  },
  plugins: [],
};
