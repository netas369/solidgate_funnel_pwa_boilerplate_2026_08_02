import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InputGroupStep } from "../steps/input-group-step";

// The component calls useLocale() for number/date formatting. The suite is
// about the skip affordance, not i18n, so stub the context rather than stand up
// a provider and a message pack.
vi.mock("next-intl", () => ({ useLocale: () => "en" }));

// The shipped boilerplate config has NO field with `optional: true`, so the
// skip affordance never renders there. These fixtures are purpose-built.
//
// The affordance's condition is `fields.some(f => f.optional) && !allFilled`,
// and allFilled treats every optional field as satisfied — so a group of ONLY
// optional fields can never show it. It needs a required field still empty
// alongside the optional one.
function step(optional: boolean) {
  return {
    stepId: "step5",
    phase: "phases.about",
    type: "input_group" as const,
    question: "steps.step5.question",
    fields: [
      { label: "steps.step5.nameLabel", storeAs: "fullName", inputType: "text" as const },
      ...(optional
        ? [
            {
              label: "steps.step5.nicknameLabel",
              storeAs: "nickname",
              inputType: "text" as const,
              optional: true,
            },
          ]
        : []),
    ],
    nextStepId: "step6",
  };
}

// The component uses t() and t.raw(); echo the key back for both.
const t = Object.assign((key: string) => key, {
  raw: (key: string) => key,
  rich: (key: string) => key,
  markup: (key: string) => key,
  has: () => true,
}) as never;

describe("InputGroupStep — skip affordance", () => {
  it("does not render when no field is optional", () => {
    render(<InputGroupStep step={step(false) as never} t={t} onContinue={vi.fn()} />);
    expect(screen.queryByText("ui.skip")).not.toBeInTheDocument();
  });

  it("renders for an optional, unfilled field", () => {
    render(<InputGroupStep step={step(true) as never} t={t} onContinue={vi.fn()} />);
    expect(screen.getByText("ui.skip")).toBeInTheDocument();
  });

  it("calls onSkip — not onContinue — so the skip is distinguishable", () => {
    const onSkip = vi.fn();
    const onContinue = vi.fn();
    render(
      <InputGroupStep
        step={step(true) as never}
        t={t}
        onContinue={onContinue}
        onSkip={onSkip}
      />,
    );
    fireEvent.click(screen.getByText("ui.skip"));
    expect(onSkip).toHaveBeenCalledWith("step6");
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("still advances when onSkip is not wired", () => {
    // A metrics feature must never be able to strand a visitor on a form.
    const onContinue = vi.fn();
    render(<InputGroupStep step={step(true) as never} t={t} onContinue={onContinue} />);
    fireEvent.click(screen.getByText("ui.skip"));
    expect(onContinue).toHaveBeenCalledWith("step6", {});
  });
});
