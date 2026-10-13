/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  // Task 3: opt into class-based dark mode so the app controls the theme
  // (via <html class="dark">) instead of silently following the OS setting.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Enterprise dark surface ramp — used by shared components for a
        // consistent look. Existing gray-* classes remain valid.
        surface: {
          DEFAULT: '#0f141a',   // app background
          raised: '#161c24',    // cards / panels
          overlay: '#1e2630',   // popovers / inputs
          border: '#2a323d',
        },
      },
    },
  },
  plugins: [],
}
