// Phase 1038 Plan 07: vitest setup file.
//
// Registers @testing-library/jest-dom's custom matchers (toBeInTheDocument,
// toHaveFocus, toHaveTextContent, etc.) so Wave 0 RED React component tests
// assert against rendered DOM correctly. Added when special-offer-email-gate
// tests required these matchers.
import '@testing-library/jest-dom/vitest';
