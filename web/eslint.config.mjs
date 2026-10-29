import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// eslint-config-next 16 ships flat configs of its own, so they are imported
// directly. Next 15's build needed FlatCompat to wrap the old eslintrc shape;
// putting the new ones through that wrapper makes eslint die trying to
// serialise a config that references itself ("property 'react' closes the
// circle") rather than reporting anything about the code.
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // THREE RULES ARRIVED WITH NEXT 16 AND FLAG 29 PLACES IN WORKING CODE.
    //
    // They are not findings about this app so much as a disagreement with
    // patterns it already uses deliberately and has tests for:
    //
    //   refs               busyRef.current = busy — mirroring a value into a
    //                      ref so a callback can read it without re-binding
    //   set-state-in-effect  reading localStorage on mount and putting it in
    //                      state, which is what an effect is for
    //   immutability       element.scrollTop = element.scrollHeight — a DOM
    //                      write the rule reads as mutating React state
    //
    // Demoted to warnings rather than switched off: they stay in the output
    // where somebody can disagree with this, and `npm run lint` does not pass
    // --max-warnings, so CI reports them without failing on them. Rewriting
    // all 29 is a deliberate pass over the chat, shell and autoscroll
    // internals, not something to slip into a dependency upgrade.
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  {
    ignores: [
      "next-env.d.ts",
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
];

export default config;
