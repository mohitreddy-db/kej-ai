import Dashboard from "./Dashboard";
import { loadCalculationTools } from "../lib/calculation-tools.mjs";
import { loadDashboardData } from "../lib/dashboard-data.mjs";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [data, calculations] = await Promise.all([loadDashboardData(), loadCalculationTools()]);
  return <Dashboard data={data} calculations={calculations} />;
}
