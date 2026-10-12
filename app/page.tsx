import fixtures from "@/fixtures/turn.json";
import { OrderUp } from "@/components/order/OrderUp";

/**
 * The fixtures say for themselves whether they are hand-written samples or
 * recorded runs. Every label in the UI that describes the demo follows this
 * flag, so recording real runs changes the wording without touching the code.
 */
const placeholder = Object.values(fixtures as Record<string, { placeholder: boolean }>).some(
  (fixture) => fixture.placeholder,
);

export default function Home() {
  return <OrderUp placeholder={placeholder} />;
}
