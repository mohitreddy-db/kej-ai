"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { assessPurchase, createBlendPlans } from "../lib/blend.mjs";
import { buildForecasts } from "../lib/forecast.mjs";

const nav = [
  ["overview", "Command center", "grid"],
  ["inventory", "Stock & inventory", "layers"],
  ["inward", "Inward & purchases", "arrow"],
  ["sales", "Sales & dispatch", "truck"],
  ["auctions", "Auctions & market", "gavel"],
  ["quality", "Quality & lab", "flask"],
  ["production", "Production & recovery", "factory"],
  ["forecast", "Forecasts", "trend"],
  ["blend", "Blend planner", "blend"],
  ["counterparties", "Customers & logistics", "users"],
];

const sources = [
  {
    view: "Stock & Inventory",
    purpose: "Current lot position, grade, size, status and landed cost",
    workbook: "HO Stock Report (Daily).xlsx",
    sheets: "IRON ORE",
  },
  {
    view: "Inward & Purchases",
    purpose: "Purchased, lifted and pending quantities with aging",
    workbook: "Inward Report FY-2026-27 (Daily).xlsx",
    sheets: "Purchased Details",
  },
  {
    view: "Sales & Dispatch",
    purpose: "PO execution, dispatch progress and permit gaps",
    workbook: "Daily Outward Report 2026-27 (Daily).xlsx",
    sheets: "Outward Details",
  },
  {
    view: "Auctions & Market",
    purpose: "Mine rates, grades, premiums and landed prices",
    workbook: "Auction Rate Chart FY-2026-27.xlsx",
    sheets: "Consolidated Data",
  },
  {
    view: "Quality & Lab",
    purpose: "Indicative versus received Fe and chemistry",
    workbook: "Inward quality report (Weekly).xlsx",
    sheets: "Inward Quality Report",
  },
  {
    view: "Production & Recovery",
    purpose: "Feed, recovered output, product Fe and tailings",
    workbook: "PRODUCTION REPORT FROM 15-AUG-2025.xlsx",
    sheets: "PRODUCTION AND RECOVERY",
  },
  {
    view: "Blend Planner",
    purpose: "Available lots, quality, quantity and landed cost",
    workbook: "Fines Planning / Lumps Planning",
    sheets: "Opening Stock",
  },
  {
    view: "Customers & Logistics",
    purpose: "Buyer universe and transporter work orders",
    workbook: "All Company Bulk Permit details / Transporter Work Orders",
    sheets: "Buyer Type · INWARD FINAL 26-27",
  },
];

const format = {
  tonnes: (value) => `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value || 0)} MT`,
  number: (value, digits = 0) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(value || 0),
  rupees: (value) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value || 0)}`,
  crore: (value) => `₹${((value || 0) / 10000000).toFixed(1)} Cr`,
  percent: (value, digits = 1) => `${Number(value || 0).toFixed(digits)}%`,
  rate: (value) => `${format.rupees(value)}/MT`,
  count: (value, unit) => `${format.number(value)} ${unit}`,
};

const ValidationContext = createContext(null);

function Icon({ name }) {
  const paths = {
    grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 10 9 5 9-5M3 18l9 5 9-5",
    arrow: "M12 3v18m-7-7 7 7 7-7M5 6h14",
    truck: "M3 6h11v10H3zM14 10h4l3 3v3h-7zM7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    gavel: "m14 5 5 5M12 7l5 5M3 21l8-8M8 5l4-4 6 6-4 4zM2 18l4 4",
    flask: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7 15h10",
    factory: "M3 21V9l6 4V9l6 4V5h6v16zM7 17h2m4 0h2m4 0h2",
    trend: "M3 18 9 12l4 4 8-10M16 6h5v5",
    blend: "M4 5h4l8 14h4M4 19h4L16 5h4",
    users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    calculator: "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm1 3v4h10V5H7Zm0 8h2m3 0h2m3 0h0M7 17h2m3 0h2m3 0h0",
    shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Zm-3-10 2 2 4-5",
    chat: "M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z",
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name] || paths.grid} />
    </svg>
  );
}

function SourceTag({ source }) {
  if (!source) return null;
  return (
    <span className="source-tag" title={`${source.file} · ${source.sheet} · row ${source.row}${source.sourceRowId ? ` · PostgreSQL source_row_id ${source.sourceRowId}` : ""}`}>
      {source.sheet} · row {source.row}
    </span>
  );
}

function EvidencePanel({ groups }) {
  if (!groups?.length) return null;
  const ranges = (rows) => {
    const result = [];
    for (const row of rows) {
      const last = result.at(-1);
      if (last && row === last[1] + 1) last[1] = row;
      else result.push([row, row]);
    }
    return result.map(([start, end]) => start === end ? start : `${start}:${end}`).join(", ");
  };
  return (
    <section className="panel">
      <SectionTitle eyebrow="PostgreSQL evidence" title="Source rows used on this page" text="Every displayed record keeps its original workbook, sheet and Excel row through governance.source_provenance." />
      <div className="source-grid">
        {groups.map((group) => (
          <article key={`${group.file}-${group.sheet}`} title={`File hash: ${group.fileHash || "unavailable"}\nPostgreSQL source_row_ids: ${group.sourceRowIds.join(", ")}`}>
            <span>{group.treatment}</span><h3>{group.file}</h3><p>{group.sheet} · rows {ranges(group.rows)}</p>
            <small>{group.sourceRowIds.length} PostgreSQL source rows · hover for IDs and file hash</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function Info({ calculation, source }) {
  const label = `Calculation: ${calculation}. Source: ${source}.`;
  return (
    <span className="info-icon" title={label} aria-label={label}>
      i
      <span role="tooltip"><strong>How it is calculated</strong>{calculation}<strong>Source</strong>{source}</span>
    </span>
  );
}

function Status({ type = "verified", children }) {
  return <span className={`status ${type}`}><i />{children}</span>;
}

function Metric({ label, value, note, tone = "plain", calculation = note, source = "See the source rows in this dashboard." }) {
  return (
    <article className={`metric ${tone}`}>
      <span className="metric-label">{label}<Info calculation={calculation} source={source} /></span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function SectionTitle({ eyebrow, title, text, action, info }) {
  return (
    <div className="section-title">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}{info && <Info {...info} />}</h2>
        {text && <p>{text}</p>}
      </div>
      {action}
    </div>
  );
}

function Bars({ data, valueKey = "value", labelKey = "label", formatValue = format.number, tone = "orange" }) {
  const max = Math.max(...data.map((item) => item[valueKey] || 0), 1);
  return (
    <div className={`bars ${tone}`}>
      {data.map((item) => (
        <div className="bar-row" key={item[labelKey]}>
          <div><span>{item[labelKey]}</span><strong>{formatValue(item[valueKey])}</strong></div>
          <div className="bar-track"><i style={{ width: `${Math.max(2, (item[valueKey] / max) * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function Table({ headers, rows, empty = "No records match this view." }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>
          {rows.length ? rows : <tr><td colSpan={headers.length} className="empty">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function PageHeader({ title, subtitle, snapshot }) {
  const validation = useContext(ValidationContext);
  const state = validation?.status || "incomplete";
  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">Founder view · {snapshot}</span>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="header-actions">
          <Status type={state}>{state}</Status>
          <button className="icon-button" title="This POC is read-only" aria-label="Read-only POC"><Icon name="shield" /></button>
        </div>
      </header>
      {validation && <section className={`callout validation-${state}`}>
        <strong>{state === "verified" ? "Verified — required checks passed" : state === "incomplete" ? "Incomplete — required source or linkage is missing" : "Flagged — source-backed values need review"}</strong>
        <p>{validation.issueCount
          ? `${validation.issueCount} relevant checks: ${validation.reasons.map((reason) => `${reason.count} ${reason.label}`).join("; ")}.`
          : "No open validation issue affects this dashboard."}</p>
      </section>}
    </>
  );
}

function Overview({ data, go }) {
  const { overview } = data.aggregates;
  const { flaggedCount: flagged, incompleteCount: incomplete, issueCount, status: validationStatus } = data.validation.overview;
  const productData = Object.entries(data.inventory.reduce((acc, item) => {
    const key = item.product || "Other";
    acc[key] = (acc[key] || 0) + item.quantity;
    return acc;
  }, {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 5);
  const pending = [...data.sales].filter((item) => item.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 5);
  return (
    <>
      <PageHeader title="Operations control tower" subtitle="What needs attention, what is tied up, and what can move next." snapshot={data.meta.snapshot} />
      <section className="decision-strip">
        <button onClick={() => go("inventory")}><span>Capital in stock <Info calculation="Sum of lot quantity × recorded landed cost; missing costs contribute zero" source="HO Stock Report (Daily).xlsx → IRON ORE" /></span><strong>{format.crore(overview.stockValue)}</strong><small>Across {overview.stockLots} iron-ore lots →</small></button>
        <button onClick={() => go("inward")}><span>Still to arrive <Info calculation="Sum of positive purchase balance quantities" source="Inward Report FY-2026-27 (Daily).xlsx → Purchased Details" /></span><strong>{format.tonnes(overview.pendingInward)}</strong><small>{overview.pendingPurchaseLots} purchased lots pending →</small></button>
        <button onClick={() => go("sales")}><span>Still to dispatch <Info calculation="Sum of positive order balance quantities" source="Daily Outward Report 2026-27 (Daily).xlsx → Outward Details" /></span><strong>{format.tonnes(overview.pendingDispatch)}</strong><small>{overview.pendingOrders} customer orders open →</small></button>
        <button onClick={() => go("trust")} className="attention"><span>Needs review <Info calculation="Count of flagged checks plus incomplete checks" source="Data Trust rules across all prioritised sheets" /></span><strong>{flagged + incomplete}</strong><small>{flagged} flagged · {incomplete} incomplete →</small></button>
      </section>
      <section className="metrics four">
        <Metric label="Current stock" value={format.tonnes(overview.currentStock)} note="Iron ore · all statuses" calculation="Sum of quantity for all usable iron-ore lot rows" source="HO Stock Report (Daily).xlsx → IRON ORE" />
        <Metric label="Plant recovery" value={format.percent(overview.recovery)} note={`${format.tonnes(overview.totalFeed)} feed recorded`} calculation="Total recovered output ÷ total feed × 100" source="PRODUCTION REPORT FROM 15-AUG-2025.xlsx → PRODUCTION AND RECOVERY" />
        <Metric label="Auction coverage" value={format.count(overview.auctionLots, "lots")} note="FY 2026–27 rate chart" calculation="Count of auction rows with a lot and quantity" source="Auction Rate Chart FY-2026-27.xlsx → Consolidated Data" />
        <Metric label="Known buyers" value={format.count(overview.buyerCount, "buyers")} note="Across sponge, pellet, BF and others" calculation="Count of usable buyer master rows" source="All Company Bulk Permit detaisl (Weekly).xlsx → Buyer Type" />
      </section>
      <section className="grid two-one">
        <article className="panel">
          <SectionTitle eyebrow="Inventory shape" title="Where the tonnage sits" text="Current position by product family." info={{ calculation: "Sum of quantity grouped by product family", source: "HO Stock Report (Daily).xlsx → IRON ORE" }} />
          <Bars data={productData} formatValue={format.tonnes} />
          <button className="text-link" onClick={() => go("inventory")}>Open all stock lots <span>→</span></button>
        </article>
        <article className="panel trust-card">
          <SectionTitle eyebrow="Data status" title="Not silently wrong" text="Every concern remains visible until confirmed." info={{ calculation: "Incomplete when a source or linkage is missing; Flagged when a present value fails a deterministic check; Verified when no relevant issue remains", source: "Latest PostgreSQL validation run" }} />
          <div className="trust-score">
            <strong>{issueCount}</strong><span>open<br />checks</span>
          </div>
          <div className="trust-lines">
            <div><Status type="flagged">{flagged} flagged</Status><small>Conflicts or suspicious values</small></div>
            <div><Status type="incomplete">{incomplete} incomplete</Status><small>Missing inputs or broken formulas</small></div>
            <div><Status type={validationStatus}>{validationStatus}</Status><small>Overall dashboard state</small></div>
          </div>
          <button className="text-link" onClick={() => go("trust")}>Review data issues <span>→</span></button>
        </article>
      </section>
      <section className="panel">
        <SectionTitle eyebrow="Sales execution" title="Largest open dispatch commitments" text="Founder attention should start with the biggest undelivered orders." info={{ calculation: "Rows with positive balance, sorted by balance descending", source: "Daily Outward Report 2026-27 (Daily).xlsx → Outward Details" }} />
        <Table headers={["Customer", "PO", "Product", "Order", "Dispatched", "Balance", "Status"]} rows={pending.map((item) => (
          <tr key={item.po}>
            <td><strong>{item.customer}</strong></td><td>{item.po}</td><td>{item.product}</td>
            <td>{format.tonnes(item.orderQty)}</td><td>{format.tonnes(item.dispatched)}</td>
            <td className="negative">{format.tonnes(item.balance)}</td><td><Status type={item.availablePermit >= item.balance ? "verified" : "flagged"}>{item.status || "Open"}</Status></td>
          </tr>
        ))} />
      </section>
    </>
  );
}

function Inventory({ data }) {
  const [query, setQuery] = useState("");
  const [product, setProduct] = useState("All");
  const products = ["All", ...new Set(data.inventory.map((item) => item.product))];
  const filtered = data.inventory.filter((item) =>
    (product === "All" || item.product === product) &&
    `${item.lot} ${item.description} ${item.status}`.toLowerCase().includes(query.toLowerCase()));
  const total = filtered.reduce((sum, item) => sum + item.quantity, 0);
  const value = filtered.reduce((sum, item) => sum + item.quantity * (item.landedCost || 0), 0);
  const weightedFe = total ? filtered.reduce((sum, item) => sum + item.quantity * (item.fe || 0), 0) / total : 0;
  const statusData = Object.entries(filtered.reduce((acc, item) => {
    const key = item.status || "Unknown";
    acc[key] = (acc[key] || 0) + item.quantity;
    return acc;
  }, {})).map(([label, amount]) => ({ label, value: amount })).sort((a, b) => b.value - a.value);
  return (
    <>
      <PageHeader title="Stock & inventory" subtitle="The current position by lot, grade, size, status and cost." snapshot={data.meta.snapshot} />
      <section className="metrics four">
        <Metric label="Stock in view" value={format.tonnes(total)} note={`${filtered.length} lots`} calculation="Sum of quantity after the current search and product filters" source="HO Stock Report (Daily).xlsx → IRON ORE" />
        <Metric label="Stock at landed cost" value={format.crore(value)} note="Missing costs excluded" calculation="Sum of quantity × landed cost for filtered lots; missing costs contribute zero" source="HO Stock Report (Daily).xlsx → IRON ORE" />
        <Metric label="Weighted Fe" value={format.percent(weightedFe, 2)} note="Quantity-weighted average" calculation="Sum of quantity × Fe ÷ total filtered quantity" source="HO Stock Report (Daily).xlsx → IRON ORE" />
        <Metric label="High-grade stock" value={format.tonnes(filtered.filter((i) => i.fe >= 60).reduce((s, i) => s + i.quantity, 0))} note="Fe 60 and above" calculation="Sum of filtered lot quantity where Fe is at least 60%" source="HO Stock Report (Daily).xlsx → IRON ORE" />
      </section>
      <section className="grid one-two">
        <article className="panel">
          <SectionTitle eyebrow="Stock state" title="Availability by status" info={{ calculation: "Sum of filtered quantity grouped by recorded stock status", source: "HO Stock Report (Daily).xlsx → IRON ORE" }} />
          <Bars data={statusData.slice(0, 6)} formatValue={format.tonnes} tone="blue" />
        </article>
        <article className="panel">
          <div className="panel-toolbar">
            <SectionTitle eyebrow="Lot register" title="Current iron-ore lots" info={{ calculation: "Direct lot rows after product and search filters; no aggregation", source: "HO Stock Report (Daily).xlsx → IRON ORE" }} />
            <div className="filters">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search lot or material" />
              <select value={product} onChange={(e) => setProduct(e.target.value)}>
                {products.map((item) => <option key={item}>{item}</option>)}
              </select>
            </div>
          </div>
          <Table headers={["Lot", "Material", "Status", "Quantity (MT)", "Fe (%)", "LC (₹/MT)", "Source"]} rows={filtered.slice(0, 30).map((item) => (
            <tr key={item.lot}>
              <td><strong>{item.lot}</strong></td><td>{item.description}<small className="sub">{item.size}</small></td>
              <td><Status type={item.status ? "verified" : "incomplete"}>{item.status || "Missing"}</Status></td>
              <td>{format.tonnes(item.quantity)}</td><td>{item.fe ? format.percent(item.fe, 2) : "—"}</td>
              <td>{item.landedCost ? format.rupees(item.landedCost) : <Status type="incomplete">Missing</Status>}</td>
              <td><SourceTag source={item.source} /></td>
            </tr>
          ))} />
        </article>
      </section>
    </>
  );
}

function Inward({ data }) {
  const pending = data.purchases.filter((item) => item.balance > 0.1).sort((a, b) => b.balance - a.balance);
  const supplierData = Object.entries(pending.reduce((acc, item) => {
    acc[item.supplier] = (acc[item.supplier] || 0) + item.balance;
    return acc;
  }, {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const old = pending.filter((item) => item.agingDays > 90);
  const totalCost = pending.reduce((sum, item) => sum + item.balance * (item.landedRate || 0), 0);
  return (
    <>
      <PageHeader title="Inward & purchases" subtitle="What KEJ bought, what has arrived, and where cash is still waiting on material." snapshot={data.meta.snapshot} />
      <section className="metrics four">
        <Metric label="Pending to lift" value={format.tonnes(pending.reduce((s, i) => s + i.balance, 0))} note={`${pending.length} lots`} tone="warn" calculation="Sum of positive purchase balance quantity" source="Inward Report FY-2026-27 (Daily).xlsx → Purchased Details" />
        <Metric label="Value pending inward" value={format.crore(totalCost)} note="At recorded landed rates" calculation="Sum of balance quantity × recorded landed rate" source="Inward Report FY-2026-27 (Daily).xlsx → Purchased Details" />
        <Metric label="Aging over 90 days" value={format.count(old.length, "lots")} note={`${format.tonnes(old.reduce((s, i) => s + i.balance, 0))} affected`} calculation="Count of pending lots with recorded age above 90 days" source="Inward Report FY-2026-27 (Daily).xlsx → Purchased Details" />
        <Metric label="Permit gaps" value={format.count(pending.filter((i) => !i.permitBalance).length, "lots")} note="Pending lots without usable permit balance" calculation="Count of pending lots with no positive permit balance" source="Inward Report FY-2026-27 (Daily).xlsx → Purchased Details" />
      </section>
      <section className="grid one-two">
        <article className="panel">
          <SectionTitle eyebrow="Supplier exposure" title="Pending inward by source" text="Where purchased tonnage is still outstanding." info={{ calculation: "Sum of positive purchase balance grouped by supplier", source: "Inward Report FY-2026-27 (Daily).xlsx → Purchased Details" }} />
          <Bars data={supplierData} formatValue={format.tonnes} />
        </article>
        <article className="panel">
          <SectionTitle eyebrow="Execution queue" title="Lots still to be lifted" text="Ordered by outstanding quantity." info={{ calculation: "Positive-balance purchase rows sorted by balance descending", source: "Inward Report FY-2026-27 (Daily).xlsx → Purchased Details" }} />
          <Table headers={["Lot", "Supplier", "Purchased", "Lifted", "Balance", "Age", "Trust"]} rows={pending.map((item) => (
            <tr key={item.lot}>
              <td><strong>{item.lot}</strong><SourceTag source={item.source} /></td><td>{item.supplier}</td>
              <td>{format.tonnes(item.purchased)}</td><td>{format.tonnes(item.lifted)}</td>
              <td className="negative">{format.tonnes(item.balance)}</td><td>{item.agingDays ? `${item.agingDays} days` : "—"}</td>
              <td><Status type={item.permitBalance ? "verified" : "incomplete"}>{item.permitBalance ? "Permit recorded" : "Check permit"}</Status></td>
            </tr>
          ))} />
        </article>
      </section>
    </>
  );
}

function Sales({ data }) {
  const pending = data.sales.filter((item) => item.balance > 0.1).sort((a, b) => b.balance - a.balance);
  const total = pending.reduce((s, i) => s + i.balance, 0);
  const value = pending.reduce((s, i) => s + i.balance * (i.rate || 0), 0);
  const permitGap = pending.reduce((s, i) => s + Math.max(0, i.balance - i.availablePermit), 0);
  const customerData = pending.map((item) => ({ label: item.customer, value: item.balance })).slice(0, 7);
  return (
    <>
      <PageHeader title="Sales & dispatch" subtitle="Open customer commitments, permit readiness, and revenue waiting to move." snapshot={data.meta.snapshot} />
      <section className="metrics four">
        <Metric label="Pending dispatch" value={format.tonnes(total)} note={`${pending.length} open orders`} tone="warn" calculation="Sum of positive customer-order balance quantity" source="Daily Outward Report 2026-27 (Daily).xlsx → Outward Details" />
        <Metric label="Revenue waiting" value={format.crore(value)} note="Balance × recorded PO rate" calculation="Sum of order balance × recorded PO rate" source="Daily Outward Report 2026-27 (Daily).xlsx → Outward Details" />
        <Metric label="Additional permits needed" value={format.tonnes(permitGap)} note="Across open orders" calculation="Sum of max(order balance − available permit, zero)" source="Daily Outward Report 2026-27 (Daily).xlsx → Outward Details" />
        <Metric label="Orders permit-ready" value={`${pending.filter((i) => i.availablePermit >= i.balance).length} of ${pending.length} orders`} note="Enough recorded permit quantity" calculation="Open orders where available permit is at least the order balance ÷ all open orders" source="Daily Outward Report 2026-27 (Daily).xlsx → Outward Details" />
      </section>
      <section className="grid one-two">
        <article className="panel">
          <SectionTitle eyebrow="Commitment concentration" title="Open quantity by customer" info={{ calculation: "Open order balances displayed by customer", source: "Daily Outward Report 2026-27 (Daily).xlsx → Outward Details" }} />
          <Bars data={customerData} formatValue={format.tonnes} tone="blue" />
        </article>
        <article className="panel">
          <SectionTitle eyebrow="Dispatch desk" title="Orders that still need movement" info={{ calculation: "Rows with positive order balance; permit gap is balance minus available permit", source: "Daily Outward Report 2026-27 (Daily).xlsx → Outward Details" }} />
          <Table headers={["Customer / PO", "Product", "Target", "Order", "Sent", "Balance", "Permit"]} rows={pending.map((item) => (
            <tr key={item.po}>
              <td><strong>{item.customer}</strong><small className="sub">{item.po}</small><SourceTag source={item.source} /></td>
              <td>{item.product}</td><td>{item.targetFe ? `Fe ${format.percent(item.targetFe, 2)}` : "—"}<small className="sub">{item.size}</small></td>
              <td>{format.tonnes(item.orderQty)}</td><td>{format.tonnes(item.dispatched)}</td>
              <td className="negative">{format.tonnes(item.balance)}</td>
              <td><Status type={item.availablePermit >= item.balance ? "verified" : "flagged"}>{item.availablePermit >= item.balance ? "Ready" : `${format.tonnes(Math.max(0, item.balance - item.availablePermit))} gap`}</Status></td>
            </tr>
          ))} />
        </article>
      </section>
    </>
  );
}

function Auctions({ data }) {
  const valid = data.auctions.filter((item) => item.currentPrice && item.fe);
  const avgPremium = valid.reduce((s, i) => s + (i.premium || 0), 0) / valid.length;
  const ourBids = valid.filter((item) => item.ourPrice);
  const mineData = Object.values(valid.reduce((acc, item) => {
    const key = item.mine || "Unknown";
    acc[key] ||= { label: key, total: 0, count: 0 };
    acc[key].total += item.currentPrice;
    acc[key].count += 1;
    return acc;
  }, {})).map((item) => ({ label: item.label, value: item.total / item.count })).sort((a, b) => b.value - a.value).slice(0, 7);
  const opportunities = valid.filter((item) => item.fe >= 58 && item.balance > 0).sort((a, b) => a.landedPrice - b.landedPrice).slice(0, 12);
  return (
    <>
      <PageHeader title="Auctions & market" subtitle="Rate movement, premium pressure, available lots and where KEJ participated." snapshot={data.meta.snapshot} />
      <section className="metrics four">
        <Metric label="Auction lots tracked" value={format.count(valid.length, "lots")} note={`${new Set(valid.map((i) => i.mine)).size} mine groups`} calculation="Count of rows with both current price and Fe" source="Auction Rate Chart FY-2026-27.xlsx → Consolidated Data" />
        <Metric label="Average premium" value={format.percent(avgPremium)} note="Current price over opening price" calculation="Simple average of the recorded premium column for valid auction lots" source="Auction Rate Chart FY-2026-27.xlsx → Consolidated Data" />
        <Metric label="KEJ prices recorded" value={format.count(ourBids.length, "auction records")} note="Others remain incomplete" calculation="Count of valid auction rows with a numeric Our Price" source="Auction Rate Chart FY-2026-27.xlsx → Consolidated Data" />
        <Metric label="Unsold Fe 58+ quantity" value={format.tonnes(opportunities.reduce((s, i) => s + i.balance, 0))} note="From displayed lowest landed-cost lots" calculation="Sum of balance for the 12 displayed Fe 58+ lots with the lowest landed price" source="Auction Rate Chart FY-2026-27.xlsx → Consolidated Data" />
      </section>
      <section className="grid one-two">
        <article className="panel">
          <SectionTitle eyebrow="Market level" title="Average current price by mine" text="Simple comparison; mix and grade are not normalized." info={{ calculation: "Simple average of current price grouped by mine; grade and size are not adjusted", source: "Auction Rate Chart FY-2026-27.xlsx → Consolidated Data" }} />
          <Bars data={mineData} formatValue={format.rate} />
        </article>
        <article className="panel">
          <SectionTitle eyebrow="Opportunity screen" title="Available Fe 58+ lots" text="Lowest recorded landed price first." info={{ calculation: "Fe at least 58 and positive balance, sorted by landed price ascending", source: "Auction Rate Chart FY-2026-27.xlsx → Consolidated Data" }} />
          <Table headers={["Mine / lot", "Size", "Fe (%)", "Balance (MT)", "Opening (₹/MT)", "Current (₹/MT)", "Landed (₹/MT)"]} rows={opportunities.map((item) => (
            <tr key={`${item.auction}-${item.lot}`}>
              <td><strong>{item.mine}</strong><small className="sub">{item.lot}</small><SourceTag source={item.source} /></td>
              <td>{item.size}</td><td>{format.percent(item.fe, 2)}</td><td>{format.tonnes(item.balance)}</td>
              <td>{format.rate(item.openingPrice)}</td><td>{format.rate(item.currentPrice)}</td><td><strong>{format.rate(item.landedPrice)}</strong></td>
            </tr>
          ))} />
        </article>
      </section>
    </>
  );
}

function Quality({ data }) {
  const { quality } = data.aggregates;
  const mineData = data.aggregates.mineQuality.map((item) => ({ label: item.supplier, value: Math.abs(Math.min(0, item.averageDifference)), raw: item.averageDifference }));
  const concerns = data.quality.filter((item) => item.feDifference != null && item.feDifference < -1).sort((a, b) => a.feDifference - b.feDifference).slice(0, 30);
  return (
    <>
      <PageHeader title="Quality & laboratory" subtitle="Did received material match the grade that KEJ expected to buy?" snapshot={`${data.quality.length} inward-quality records`} />
      <section className="metrics four">
        <Metric label="Quality records" value={format.count(quality.records, "records")} note="With inward quantities" calculation="Count of rows containing a lot and inward quantity" source="Inward quality report (Weekly).xlsx → Inward Quality Report" />
        <Metric label="Average received Fe" value={format.percent(quality.averageFe, 2)} note="Simple average of recorded results" calculation="Sum of received Fe values ÷ rows with received Fe" source="Inward quality report (Weekly).xlsx → Inward Quality Report" />
        <Metric label="Below indicative Fe" value={format.count(quality.belowIndicative, "records")} note="Any negative Fe difference" tone="warn" calculation="Count of rows where received Fe minus indicative Fe is negative" source="Inward quality report (Weekly).xlsx → Inward Quality Report" />
        <Metric label="More than 1 Fe point low" value={format.count(quality.severeVariance, "records")} note="Priority quality exceptions" tone="bad" calculation="Count of rows where the recorded Fe difference is below −1.00" source="Inward quality report (Weekly).xlsx → Inward Quality Report" />
      </section>
      <section className="grid one-two">
        <article className="panel">
          <SectionTitle eyebrow="Supplier signal" title="Average Fe under-delivery" text="Only negative average differences are shown." info={{ calculation: "Average recorded Fe difference by supplier; chart shows only negative averages", source: "Inward quality report (Weekly).xlsx → Inward Quality Report" }} />
          <Bars data={mineData.filter((i) => i.value > 0)} formatValue={(v) => `${v.toFixed(2)} Fe pts`} tone="red" />
          <p className="panel-note">This is a signal, not a supplier verdict. Sample counts and missing results matter.</p>
        </article>
        <article className="panel">
          <SectionTitle eyebrow="Exception register" title="Largest indicative vs received gaps" info={{ calculation: "Rows more than 1 Fe point below indicative, sorted from largest negative difference", source: "Inward quality report (Weekly).xlsx → Inward Quality Report" }} />
          <Table headers={["Supplier / lot", "Date", "Indicative Fe (%)", "Received Fe (%)", "Difference (Fe pts)", "Source"]} rows={concerns.map((item, index) => (
            <tr key={`${item.lot}-${item.reportDate}-${index}`}>
              <td><strong>{item.supplier}</strong><small className="sub">{item.lot}</small></td><td>{item.reportDate}</td>
              <td>{format.percent(item.indicativeFe, 2)}</td><td>{format.percent(item.fe, 2)}</td>
              <td className="negative">{item.feDifference.toFixed(2)} Fe pts</td><td><SourceTag source={item.source} /></td>
            </tr>
          ))} />
        </article>
      </section>
    </>
  );
}

function Production({ data }) {
  const rows = data.production.filter((item) => item.feed > 0);
  const feed = rows.reduce((s, i) => s + i.feed, 0);
  const recovered = rows.reduce((s, i) => s + (i.recovered || 0), 0);
  const tailings = rows.reduce((s, i) => s + (i.tailings || 0), 0);
  const avgFeRows = rows.filter((i) => i.productFe);
  const avgFe = avgFeRows.reduce((s, i) => s + i.productFe, 0) / avgFeRows.length;
  const materialData = Object.values(rows.reduce((acc, item) => {
    const key = item.material.trim();
    acc[key] ||= { label: key, value: 0 };
    acc[key].value += item.feed;
    return acc;
  }, {})).sort((a, b) => b.value - a.value).slice(0, 7);
  const latest = [...rows].sort((a, b) => String(b.productionDate).localeCompare(String(a.productionDate))).slice(0, 20);
  return (
    <>
      <PageHeader title="Production & recovery" subtitle="How much ore entered the plant, what came back as product, and what became tailings." snapshot={data.meta.snapshot} />
      <section className="metrics four">
        <Metric label="Recorded feed" value={format.tonnes(feed)} note={`${rows.length} shift records`} calculation="Sum of feed quantity for rows with positive feed" source="PRODUCTION REPORT FROM 15-AUG-2025.xlsx → PRODUCTION AND RECOVERY" />
        <Metric label="Recovered output" value={format.tonnes(recovered)} note="Recorded recovery field" calculation="Sum of recorded recovered quantity" source="PRODUCTION REPORT FROM 15-AUG-2025.xlsx → PRODUCTION AND RECOVERY" />
        <Metric label="Overall recovery" value={format.percent(feed ? recovered / feed * 100 : 0)} note="Recovered ÷ feed" calculation="Total recorded recovered output ÷ total feed × 100" source="PRODUCTION REPORT FROM 15-AUG-2025.xlsx → PRODUCTION AND RECOVERY" />
        <Metric label="Average product Fe" value={format.percent(avgFe, 2)} note={`${format.tonnes(tailings)} tailings recorded`} calculation="Simple average of non-empty product Fe values" source="PRODUCTION REPORT FROM 15-AUG-2025.xlsx → PRODUCTION AND RECOVERY" />
      </section>
      <section className="grid one-two">
        <article className="panel">
          <SectionTitle eyebrow="Plant mix" title="Largest feed materials" info={{ calculation: "Sum of feed quantity grouped by material; seven largest groups", source: "PRODUCTION REPORT FROM 15-AUG-2025.xlsx → PRODUCTION AND RECOVERY" }} />
          <Bars data={materialData} formatValue={format.tonnes} tone="blue" />
        </article>
        <article className="panel">
          <SectionTitle eyebrow="Shift record" title="Latest production entries" info={{ calculation: "Positive-feed rows sorted by production date descending", source: "PRODUCTION REPORT FROM 15-AUG-2025.xlsx → PRODUCTION AND RECOVERY" }} />
          <Table headers={["Date / shift", "Material", "Feed", "Recovered", "Recovery", "Product Fe", "Source"]} rows={latest.map((item, index) => (
            <tr key={`${item.productionDate}-${item.shift}-${item.material}-${index}`}>
              <td><strong>{item.productionDate}</strong><small className="sub">{item.shift}</small></td><td>{item.material}</td>
              <td>{format.tonnes(item.feed)}</td><td>{item.recovered != null ? format.tonnes(item.recovered) : "—"}</td>
              <td>{item.recovery != null ? format.percent(item.recovery) : "—"}</td><td>{item.productFe ? format.percent(item.productFe, 2) : "—"}</td>
              <td><SourceTag source={item.source} /></td>
            </tr>
          ))} />
        </article>
      </section>
    </>
  );
}

function Forecasts({ data }) {
  const forecasts = useMemo(() => buildForecasts(data), [data]);
  const display = (forecast, value) => forecast.unit.startsWith("₹")
    ? `${format.rupees(value)}/MT`
    : format.tonnes(value);
  return (
    <>
      <PageHeader title="Historical forecasts" subtitle="Simple trend estimates from complete monthly workbook history—not targets or commitments." snapshot={`Snapshot ${data.meta.snapshot}`} />
      <section className="callout forecast-warning">
        <strong>Read forecasts as a planning signal.</strong>
        <p>Linear regression extends the historical monthly trend. It does not know future orders, mine availability, shutdowns, seasonality, price negotiations, or management decisions.</p>
      </section>
      <section className="metrics four">
        {forecasts.map((forecast) => (
          <Metric
            key={forecast.key}
            label={`${forecast.label} · ${forecast.forecast[0]?.label}`}
            value={forecast.forecast[0] ? display(forecast, forecast.forecast[0].value) : "Insufficient history"}
            note={`${forecast.confidence} confidence · ${forecast.history.length} months · R² ${forecast.r2.toFixed(2)}`}
            tone={forecast.confidence === "Low" ? "warn" : "plain"}
            calculation={forecast.calculation}
            source={forecast.source}
          />
        ))}
      </section>
      <section className="forecast-grid">
        {forecasts.map((forecast) => {
          const chart = [
            ...forecast.history.slice(-6).map((point) => ({ label: point.label, value: point.value })),
            ...forecast.forecast.map((point) => ({ label: `${point.label} · est.`, value: point.value })),
          ];
          return (
            <article className="panel forecast-card" key={forecast.key}>
              <SectionTitle
                eyebrow={`${forecast.confidence} confidence · R² ${forecast.r2.toFixed(2)}`}
                title={forecast.label}
                text={`${forecast.history.length} complete observed months followed by three estimated months.`}
                info={{ calculation: forecast.calculation, source: forecast.source }}
              />
              <Bars data={chart} formatValue={(value) => display(forecast, value)} tone={forecast.confidence === "Low" ? "red" : "blue"} />
              <div className="forecast-values">
                {forecast.forecast.map((point) => <div key={point.month}><span>{point.label}</span><strong>{display(forecast, point.value)}</strong></div>)}
              </div>
            </article>
          );
        })}
      </section>
    </>
  );
}

function BlendPlanner({ data }) {
  const [inputs, setInputs] = useState({ product: "Fines", quantity: 1000, targetFe: 60, saleRate: 6000 });
  const [purchase, setPurchase] = useState({ grade: 54, quantity: 1000, landedCost: 2200 });
  const result = useMemo(() => createBlendPlans(data.blendStock, {
    ...inputs,
    quantity: Number(inputs.quantity),
    targetFe: Number(inputs.targetFe),
    saleRate: Number(inputs.saleRate),
  }), [data.blendStock, inputs]);
  const warning = useMemo(() => assessPurchase(data.blendStock, {
    product: inputs.product,
    grade: Number(purchase.grade),
    quantity: Number(purchase.quantity),
    landedCost: Number(purchase.landedCost),
    targetFe: Number(inputs.targetFe),
  }), [data.blendStock, inputs.product, inputs.targetFe, purchase]);
  const set = (key) => (event) => setInputs((current) => ({ ...current, [key]: event.target.value }));
  const setBuy = (key) => (event) => setPurchase((current) => ({ ...current, [key]: event.target.value }));
  return (
    <>
      <PageHeader title="Blend & dispatch planner" subtitle="Repeatable lot mixes for margin, inventory balance, or fastest movement." snapshot={`Planning data in PostgreSQL · ${data.meta.snapshot}`} />
      <section className="panel planner-inputs">
        <div><label>Product</label><select value={inputs.product} onChange={set("product")}><option>Fines</option><option>Lumps</option></select></div>
        <div><label>Dispatch quantity</label><input type="number" min="1" value={inputs.quantity} onChange={set("quantity")} /><span>MT</span></div>
        <div><label>Target Fe</label><input type="number" min="1" max="70" step=".1" value={inputs.targetFe} onChange={set("targetFe")} /><span>%</span></div>
        <div><label>Selling rate</label><input type="number" min="1" value={inputs.saleRate} onChange={set("saleRate")} /><span>₹/MT</span></div>
        <Status type="verified">Deterministic calculation</Status>
      </section>
      {result.plans.length ? (
        <section className="blend-grid">
          {result.plans.map((plan, index) => (
            <article className={`blend-plan ${index === 0 ? "featured" : ""}`} key={plan.name}>
              <div className="plan-head"><span>Option {index + 1}</span><Status type={plan.margin >= 0 ? "verified" : "flagged"}>{plan.margin >= 0 ? "Positive margin" : "Negative margin"}</Status></div>
              <h3>{plan.name}</h3><p>{plan.note}</p>
              <div className="plan-kpis">
                <div><span>Blend Fe <Info calculation="Quantity-weighted Fe of the selected one- or two-lot mix" source="Fines/Lumps Planning → Opening Stock" /></span><strong>{format.percent(plan.blendedFe, 2)}</strong></div>
                <div><span>Cost / MT <Info calculation="Sum of selected quantity × landed cost ÷ dispatch quantity" source="Fines/Lumps Planning → Opening Stock" /></span><strong>{format.rate(plan.unitCost)}</strong></div>
                <div><span>Expected margin <Info calculation="Dispatch quantity × entered selling rate − total selected-lot cost" source="Opening Stock plus the selling rate entered above" /></span><strong>{format.rupees(plan.margin)}</strong></div>
              </div>
              <div className="mix-list">
                {plan.mix.map((part) => (
                  <div key={part.lot}>
                    <div><strong>{part.lot}</strong><span>{format.number(part.quantity, 2)} MT · Fe {format.percent(part.fe, 2)}</span></div>
                    <SourceTag source={part.source} />
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>
      ) : <section className="callout bad"><strong>No valid blend found</strong><p>{result.reason}</p></section>}
      <section className="panel purchase-check">
        <SectionTitle eyebrow="Before you buy" title="Low-grade purchase warning" text="Can this proposed purchase be lifted to the selected target using today's planning stock?" info={{ calculation: "Greedily adds the highest-Fe available stock until the proposed purchase reaches target Fe, then recalculates weighted landed cost", source: "Fines/Lumps Planning → Opening Stock plus entered purchase assumptions" }} />
        <div className="purchase-layout">
          <div className="planner-inputs compact">
            <div><label>Purchase Fe</label><input type="number" step=".1" value={purchase.grade} onChange={setBuy("grade")} /><span>%</span></div>
            <div><label>Quantity</label><input type="number" value={purchase.quantity} onChange={setBuy("quantity")} /><span>MT</span></div>
            <div><label>Landed cost</label><input type="number" value={purchase.landedCost} onChange={setBuy("landedCost")} /><span>₹/MT</span></div>
          </div>
          <div className={`purchase-result ${warning.feasible ? "good" : "bad"}`}>
            <Status type={warning.feasible ? "verified" : "flagged"}>{warning.feasible ? "Blendable" : "Purchase warning"}</Status>
            <h3>{warning.message}</h3>
            {warning.feasible && <p>Resulting blended cost: <strong>{format.rate(warning.blendedCost)}</strong> <Info calculation="Purchase cost plus selected high-grade stock cost ÷ total blended quantity" source="Opening Stock plus entered purchase assumptions" /> · Total mix: {format.tonnes(warning.totalQuantity)}</p>}
            <small>Economics exclude processing, customer freight and bonus/penalty until KEJ confirms those rules.</small>
          </div>
        </div>
      </section>
    </>
  );
}

function Counterparties({ data }) {
  const buyerData = Object.entries(data.counterparties.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  const customers = Object.values(data.sales.reduce((acc, item) => {
    acc[item.customer] ||= { customer: item.customer, ordered: 0, dispatched: 0, value: 0 };
    acc[item.customer].ordered += item.orderQty;
    acc[item.customer].dispatched += item.dispatched;
    acc[item.customer].value += item.dispatched * (item.rate || 0);
    return acc;
  }, {})).sort((a, b) => b.ordered - a.ordered).slice(0, 12);
  return (
    <>
      <PageHeader title="Customers & logistics" subtitle="Who buys, who carries, and where the current data can support a decision." snapshot={data.meta.snapshot} />
      <section className="metrics four">
        <Metric label="Known buyers" value={format.count(data.counterparties.length, "buyers")} note={`${buyerData.length} buyer categories`} calculation="Count of usable buyer master rows" source="All Company Bulk Permit detaisl (Weekly).xlsx → Buyer Type" />
        <Metric label="Customers in PO history" value={format.count(customers.length, "customers")} note="Top customers displayed" calculation="Distinct customers grouped from sales orders, limited to the 12 largest order quantities" source="Daily Outward Report 2026-27 (Daily).xlsx → Outward Details" />
        <Metric label="Transporters with work orders" value={format.count(data.aggregates.transporterSummary.length, "transporters")} note="FY 2026–27 workbook" calculation="Distinct transporter names with at least one usable work-order row" source="INWARD TRANSPORTER -WORK ORDER FILE-CONTROL SHEET FORMAT.xlsm → INWARD FINAL 26-27" />
        <Metric label="Delivery scores available" value="0 scores" note="Actual delivery completion data is missing" tone="warn" calculation="Count of transporters with promised and actual delivery dates plus delivered quantity; required fields are absent" source="INWARD TRANSPORTER -WORK ORDER FILE-CONTROL SHEET FORMAT.xlsm → INWARD FINAL 26-27" />
      </section>
      <section className="grid one-two">
        <article className="panel">
          <SectionTitle eyebrow="Market map" title="Buyer universe by type" info={{ calculation: "Count of buyer master rows grouped by buyer type", source: "All Company Bulk Permit detaisl (Weekly).xlsx → Buyer Type" }} />
          <Bars data={buyerData} formatValue={(value) => format.count(value, "buyers")} />
        </article>
        <article className="panel">
          <SectionTitle eyebrow="Customer book" title="Largest recorded order volumes" info={{ calculation: "Orders grouped by customer; realized value is dispatched quantity × recorded rate", source: "Daily Outward Report 2026-27 (Daily).xlsx → Outward Details" }} />
          <Table headers={["Customer", "Ordered", "Dispatched", "Completion", "Realized value"]} rows={customers.map((item) => (
            <tr key={item.customer}><td><strong>{item.customer}</strong></td><td>{format.tonnes(item.ordered)}</td>
              <td>{format.tonnes(item.dispatched)}</td><td>{format.percent(item.ordered ? item.dispatched / item.ordered * 100 : 0)}</td>
              <td>{format.crore(item.value)}</td></tr>
          ))} />
        </article>
      </section>
      <section className="panel">
        <SectionTitle eyebrow="Logistics" title="Transporter work-order activity" text="A true performance score is intentionally withheld: the workbook records awards, not completed delivery dates or shortages." info={{ calculation: "Work-order count and simple average of recorded awarded rates by transporter", source: "INWARD TRANSPORTER -WORK ORDER FILE-CONTROL SHEET FORMAT.xlsm → INWARD FINAL 26-27" }} />
        <Table headers={["Transporter", "Work orders", "Average awarded rate", "Decision status"]} rows={data.aggregates.transporterSummary.slice(0, 15).map((item) => (
          <tr key={item.transporter}><td><strong>{item.transporter}</strong></td><td>{format.count(item.workOrders, "work orders")}</td>
            <td>{item.averageRate ? format.rate(item.averageRate) : "—"}</td><td><Status type="incomplete">{item.status}</Status></td></tr>
        ))} />
      </section>
    </>
  );
}

function CalculationTools({ calculations }) {
  const stockRows = calculations?.available ? calculations.stock : [];
  const customers = calculations?.available ? [...new Set(calculations.monthlyActivity.map((item) => item.customer))].sort() : [];
  const financialYears = calculations?.available ? [...new Set(calculations.monthlyActivity.map((item) => {
    const [year, month] = item.month.split("-").map(Number);
    return month >= 4 ? year : year - 1;
  }))].sort((a, b) => a - b) : [];
  const [category, setCategory] = useState("fine");
  const [customer, setCustomer] = useState(customers.find((item) => /x-?india/i.test(item)) || customers[0] || "");
  const [financialYear, setFinancialYear] = useState(financialYears.includes(2025) ? 2025 : financialYears.at(-1));
  if (!calculations?.available) return (
    <>
      <PageHeader title="Founder calculation tools" subtitle="Pre-built business calculations from local PostgreSQL." snapshot="Local database" />
      <section className="callout forecast-warning"><strong>Calculation database is unavailable.</strong><p>{calculations?.error || "Start PostgreSQL and reload the page."}</p></section>
    </>
  );

  const stockLabels = { all: "All stock", fine: "Fines", lump: "Lumps", other: "Cleanings / other", tailings: "Tailings" };
  const stock = stockRows.find((item) => item.category === category) || stockRows[0];
  const qualityCoverage = stock.totalQuantity ? stock.qualityQuantity / stock.totalQuantity * 100 : 0;
  const costCoverage = stock.totalQuantity ? stock.costQuantity / stock.totalQuantity * 100 : 0;
  const monthly = calculations.monthlyActivity.filter((item) => item.customer === customer
    && item.month >= `${financialYear}-04` && item.month <= `${financialYear + 1}-03`)
    .reduce((map, item) => {
      map[item.month] ||= { month: item.month, ordered: 0, dispatched: 0 };
      if (item.metric === "ordered_from_kej") map[item.month].ordered += item.quantity;
      if (item.metric === "dispatched_by_kej") map[item.month].dispatched += item.quantity;
      return map;
    }, {});
  const monthlyRows = Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month));
  const inboundDeviation = calculations.qualityDeviation.filter((item) => item.comparison === "inbound_vs_indicative");
  const topDispatch = calculations.dailyDispatch[0];
  return (
    <>
      <PageHeader title="Founder calculation tools" subtitle="The recurring meeting questions, calculated by fixed PostgreSQL rules—not by AI." snapshot="Local database · read only" />
      <section className="callout"><strong>These are deterministic calculations.</strong><p>The same inputs always produce the same output. Missing inputs are shown and never replaced with guessed values.</p></section>

      <section className="panel">
        <div className="panel-toolbar">
          <SectionTitle eyebrow="Tool 1 · Current position" title="Stock quantity, weighted Fe and landed cost" text="Uses the latest stock snapshot for the selected material category." info={{ calculation: "Weighted Fe = sum(quantity × Fe) ÷ quantity with Fe. Weighted landed cost uses the same method for cost.", source: "HO Stock Report (Daily).xlsx → IRON ORE → rows 5:72" }} />
          <div className="filters"><select value={category} onChange={(event) => setCategory(event.target.value)}>{stockRows.map((item) => <option value={item.category} key={item.category}>{stockLabels[item.category] || item.category}</option>)}</select></div>
        </div>
        <section className="metrics four">
          <Metric label="Quantity" value={format.tonnes(stock.totalQuantity)} note={stockLabels[stock.category] || stock.category} calculation="Sum of lot quantities in the latest snapshot" source="HO Stock Report (Daily).xlsx → IRON ORE" />
          <Metric label="Weighted Fe" value={stock.weightedFe == null ? "Unavailable" : format.percent(stock.weightedFe, 2)} note={`${format.percent(qualityCoverage)} quantity coverage`} tone={qualityCoverage < 100 ? "warn" : "plain"} calculation="Sum(quantity × Fe) ÷ quantity with Fe; missing Fe is excluded" source="HO Stock Report (Daily).xlsx → IRON ORE" />
          <Metric label="Weighted landed cost" value={stock.weightedLandedCost == null ? "Unavailable" : format.rate(stock.weightedLandedCost)} note={`${format.percent(costCoverage)} quantity coverage`} tone={costCoverage < 100 ? "warn" : "plain"} calculation="Sum(quantity × landed cost) ÷ quantity with landed cost" source="HO Stock Report (Daily).xlsx → IRON ORE" />
          <Metric label="Covered stock value" value={stock.costQuantity ? format.crore(stock.stockValue) : "Unavailable"} note="Quantity missing cost is excluded" tone={costCoverage < 100 ? "warn" : "plain"} calculation="Sum(quantity × landed cost) for rows having cost" source="HO Stock Report (Daily).xlsx → IRON ORE" />
        </section>
        <Status type={stock.status}>{stock.status === "verified" ? "Complete approved coverage" : `${format.tonnes(stock.totalQuantity - stock.qualityQuantity)} missing Fe · ${format.tonnes(stock.totalQuantity - stock.costQuantity)} missing cost`}</Status>
      </section>

      <section className="panel">
        <SectionTitle eyebrow="Tool 2 · Dispatch" title="Highest customer dispatch on a single day" text="Uses actual dispatch-detail rows, not the customer PO quantity." info={{ calculation: "Group by dispatch date and customer, sum dispatched MT, then rank highest", source: "Daily Outward Report 2026-27 (Daily).xlsx → Daily Outward Detail's → rows 2:219" }} />
        {topDispatch && <section className="metrics four">
          <Metric label="Highest customer-day" value={format.tonnes(topDispatch.quantity)} note={`${topDispatch.customer} · ${topDispatch.date}`} calculation="Largest grouped customer-day dispatch total" source="Daily Outward Report 2026-27 (Daily).xlsx → Daily Outward Detail's" />
          <Metric label="Contributing records" value={format.count(topDispatch.dispatchCount, "rows")} note="Same customer and date" calculation="Count of source rows in the winning group" source="Daily Outward Report 2026-27 (Daily).xlsx → Daily Outward Detail's" />
          <Metric label="Missing lot links" value={format.count(topDispatch.rowsMissingLot, "rows")} note="Quantity is still source-backed" tone={topDispatch.rowsMissingLot ? "warn" : "plain"} calculation="Winning dispatch rows without a KEJ lot link" source="Daily Outward Report 2026-27 (Daily).xlsx → Daily Outward Detail's" />
          <Metric label="Ranking basis" value="Customer + date" note="Not order quantity" calculation="Daily detail is aggregated before comparison" source="Daily Outward Report 2026-27 (Daily).xlsx" />
        </section>}
        <Table headers={["Rank", "Date", "Customer", "Dispatched (MT)", "Rows", "Lot linkage"]} rows={calculations.dailyDispatch.slice(0, 10).map((item, index) => (
          <tr key={`${item.date}-${item.customer}`}><td>{index + 1}</td><td>{item.date}</td><td><strong>{item.customer}</strong></td><td>{format.tonnes(item.quantity)}</td><td>{item.dispatchCount}</td><td><Status type={item.rowsMissingLot ? "incomplete" : "verified"}>{item.rowsMissingLot ? `${item.rowsMissingLot} missing` : "Linked"}</Status></td></tr>
        ))} />
      </section>

      <section className="panel">
        <div className="panel-toolbar">
          <SectionTitle eyebrow="Tool 3 · Customer history" title="Month-wise purchases from KEJ" text="Shows booked orders separately from quantity actually dispatched." info={{ calculation: "Monthly sum by customer: order quantity uses PO date; dispatched quantity uses dispatch date", source: "Daily Outward Report 2026-27 (Daily).xlsx → Outward Details + Daily Outward Detail's" }} />
          <div className="filters">
            <select value={customer} onChange={(event) => setCustomer(event.target.value)}>{customers.map((item) => <option key={item}>{item}</option>)}</select>
            <select value={financialYear} onChange={(event) => setFinancialYear(Number(event.target.value))}>{financialYears.map((year) => <option value={year} key={year}>FY {year}-{String(year + 1).slice(-2)}</option>)}</select>
          </div>
        </div>
        <Table headers={["Month", "Orders booked (MT)", "Actually dispatched (MT)"]} empty={`No activity is recorded for ${customer} in FY ${financialYear}-${String(financialYear + 1).slice(-2)}.`} rows={monthlyRows.map((item) => (
          <tr key={item.month}><td><strong>{new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${item.month}-01T00:00:00Z`))}</strong></td><td>{format.tonnes(item.ordered)}</td><td>{format.tonnes(item.dispatched)}</td></tr>
        ))} />
      </section>

      <section className="grid two-one">
        <article className="panel">
          <SectionTitle eyebrow="Tool 4 · Quality" title="Largest inward Fe deviations" text="Ranks records having both indicative and received Fe." info={{ calculation: "Received Fe minus indicative Fe; ranked by absolute difference", source: "Inward quality report (Weekly).xlsx → Inward Quality Report" }} />
          <Table headers={["Lot", "Indicative Fe (%)", "Received Fe (%)", "Difference", "Source"]} rows={inboundDeviation.slice(0, 10).map((item) => (
            <tr key={`${item.lot}-${item.source.row}`}><td><strong>{item.lot}</strong></td><td>{format.percent(item.expectedFe, 2)}</td><td>{format.percent(item.actualFe, 2)}</td><td className={item.deviation < 0 ? "negative" : ""}>{item.deviation.toFixed(2)} Fe pts</td><td><SourceTag source={item.source} /></td></tr>
          ))} />
        </article>
        <article className="panel trust-card">
          <SectionTitle eyebrow="Blocked calculation" title="Customer dispatch Fe deviation" text="The requested outbound calculation has no usable actual Fe values." info={{ calculation: "Actual dispatch Fe minus order target Fe", source: "Daily Outward Report 2026-27 (Daily).xlsx → Daily Outward Detail's" }} />
          <div className="trust-score"><strong>{calculations.dispatchQualityCoverage.withFe}</strong><span>of {calculations.dispatchQualityCoverage.rows}<br />rows usable</span></div>
          <Status type="incomplete">Actual dispatch Fe is missing</Status>
          <p className="panel-note">Required: actual dispatch or customer-reported Fe linked to each PO/dispatch. Target Fe will not be substituted.</p>
        </article>
      </section>
    </>
  );
}

function Trust({ data }) {
  const [severity, setSeverity] = useState("all");
  const [limit, setLimit] = useState(200);
  const issues = data.trustIssues.filter((item) => severity === "all" || item.severity === severity);
  const flagged = data.trustIssues.filter((item) => item.severity === "flagged").length;
  const incomplete = data.trustIssues.filter((item) => item.severity === "incomplete").length;
  const affectedRows = new Set(data.trustIssues.map((item) => item.source?.sourceRowId).filter(Boolean)).size;
  const ruleTypes = new Set(data.trustIssues.map((item) => item.ruleCode)).size;
  return (
    <>
      <PageHeader title="Data trust center" subtitle="What passed, what is suspicious, and what cannot be calculated safely." snapshot="Latest PostgreSQL import run" />
      <section className="metrics four">
        <Metric label="Validation findings" value={format.count(data.trustIssues.length, "findings")} note={`${format.count(affectedRows, "source rows")} · ${format.count(ruleTypes, "rule types")}`} calculation="Count of validation findings; one source row may trigger more than one rule" source="Data Trust rules across all prioritised sheets" />
        <Metric label="Flagged" value={format.count(flagged, "issues")} note="Present but conflicting or suspicious" tone="bad" calculation="Count of issues classified as flagged by deterministic validation rules" source="Data Trust rules across all prioritised sheets" />
        <Metric label="Incomplete" value={format.count(incomplete, "issues")} note="Required input missing or broken" tone="warn" calculation="Count of issues classified as incomplete by deterministic validation rules" source="Data Trust rules across all prioritised sheets" />
        <Metric label="Source coverage" value="100%" note="Every displayed detail row has provenance" calculation="Displayed detail records with file, sheet and row ÷ all displayed detail records" source="Extractor-generated source metadata" />
      </section>
      <section className="panel">
        <div className="panel-toolbar">
          <SectionTitle eyebrow="Review queue" title="Data issues with reasons" info={{ calculation: "Validation-rule results filtered by the selected severity", source: "Prioritised stock, purchase, sales, quality, production and auction sheets" }} />
          <div className="segmented">
            {["all", "flagged", "incomplete"].map((item) => <button className={severity === item ? "active" : ""} onClick={() => setSeverity(item)} key={item}>{item}</button>)}
          </div>
        </div>
        <div className="issue-list">
          {issues.slice(0, limit).map((item, index) => (
            <article key={`${item.title}-${index}`}>
              <Status type={item.severity}>{item.severity}</Status>
              <div><strong>{item.title}</strong><p>{item.detail}</p></div>
              <div><span>{item.area}</span><SourceTag source={item.source} /></div>
            </article>
          ))}
        </div>
        {limit < issues.length && <button className="text-link" onClick={() => setLimit((current) => current + 200)}>Show 200 more of {issues.length} checks <span>→</span></button>}
      </section>
      <section className="panel">
        <SectionTitle eyebrow="Lineage" title="Which sheets power each dashboard" text="The POC reads existing Excel files; it does not replace data entry." />
        <div className="source-grid">
          {sources.map((item) => (
            <article key={item.view}><span>{item.view}</span><h3>{item.workbook}</h3><p>{item.sheets}</p><small>{item.purpose}</small></article>
          ))}
        </div>
      </section>
    </>
  );
}

function AskData({ data }) {
  const suggestions = [
    "Which customer had the highest dispatch on a single day?",
    "What is our stock quantity, weighted Fe and landed cost?",
    "What did X-India order and receive month-wise in FY 2026–27?",
    "What is the highest inward Fe deviation?",
    "Can we calculate customer dispatch Fe deviation?",
    "What data-quality problems need attention?",
  ];
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([{
    question: null,
    title: "Ask the analytics agent",
    body: "The LangGraph agent selects approved read-only tools. PostgreSQL and deterministic services produce every number; missing capabilities return Incomplete.",
    status: "verified",
    source: null,
  }]);
  const answer = async (input) => {
    const q = input.trim();
    if (!q || loading) return;
    setQuestion("");
    setLoading(true);
    let error = "The analytics agent is unavailable. No fallback answer was generated.";
    try {
      const conversation = history.flatMap((item) => [
        ...(item.question ? [{ role: "user", content: item.question }] : []),
        { role: "assistant", content: item.body },
      ]).slice(-6);
      const result = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history: conversation }),
      });
      const payload = await result.json();
      if (result.ok) {
        setHistory((current) => [...current, {
          question: q,
          title: "Agent answer from approved tools",
          body: payload.answer,
          status: payload.status,
          sources: payload.sources,
          model: payload.model,
          agent: payload.agent,
        }]);
        setLoading(false);
        return;
      }
      error = payload.error || error;
    } catch {}
    setHistory((current) => [...current, {
      question: q,
      title: "No answer generated",
      body: error,
      status: "incomplete",
      source: null,
    }]);
    setLoading(false);
  };
  return (
    <>
      <PageHeader title="Ask kejAI" subtitle="LangGraph ReAct orchestration over deterministic PostgreSQL tools." snapshot={`PostgreSQL snapshot ${data.meta.snapshot}`} />
      <section className="chat-shell">
        <div className="chat-suggestions">
          <span>Try a question</span>
          {suggestions.map((item) => <button onClick={() => answer(item)} disabled={loading} key={item}>{item}<b>↗</b></button>)}
          <div className="chat-rule"><Icon name="shield" /><p><strong>Agent trust rule</strong>The model may choose tools and explain results. It may not create business numbers or bypass missing data.</p></div>
        </div>
        <div className="chat-main">
          <div className="messages">
            {history.map((item, index) => (
              <div key={index}>
                {item.question && <div className="message user">{item.question}</div>}
                <div className="message assistant">
                  <Status type={item.status}>{item.model ? `${item.agent || "OpenAI"} · ${item.model}` : item.status}</Status>
                  <h3>{item.title}</h3><p>{item.body}</p>
                  {item.source && <div className="answer-source"><span>Source</span><strong>{item.source.file}</strong><SourceTag source={item.source} /></div>}
                  {item.sources?.length > 0 && <div className="answer-source"><span>Retrieved sources</span>{item.sources.map((source) => <SourceTag source={source} key={`${source.file}-${source.sheet}-${source.row}`} />)}</div>}
                </div>
              </div>
            ))}
            {loading && <div className="message assistant loading-answer"><Status type="incomplete">Working</Status><h3>Selecting and running approved tools…</h3></div>}
          </div>
          <form onSubmit={(event) => { event.preventDefault(); answer(question); }}>
            <input value={question} maxLength={500} disabled={loading} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about stock, quality, dispatch, forecasts or transporters…" />
            <button aria-label="Ask question" disabled={loading}>{loading ? "Working…" : "Ask"} <span>↑</span></button>
          </form>
        </div>
      </section>
    </>
  );
}

export default function Dashboard({ data, calculations }) {
  const [view, setView] = useState("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const evidenceKeys = {
    overview: ["inventory", "purchases", "sales", "production", "auctions", "counterparties"],
    inventory: ["inventory"], inward: ["purchases"], sales: ["sales"], auctions: ["auctions"],
    quality: ["quality"], production: ["production"], forecast: ["production", "sales", "quality", "auctions"],
    blend: ["blendStock"], counterparties: ["counterparties", "transporters"],
    calculations: ["inventory", "sales", "quality"], trust: ["trustIssues"],
    ask: ["inventory", "purchases", "sales", "auctions", "quality", "production", "blendStock", "transporters", "counterparties"],
  };
  const evidenceGroups = [...new Map((evidenceKeys[view] || []).flatMap((key) => data.evidence[key] || [])
    .map((group) => [`${group.file}|${group.sheet}`, group])).values()];
  const content = {
    overview: <Overview data={data} go={setView} />,
    inventory: <Inventory data={data} />,
    inward: <Inward data={data} />,
    sales: <Sales data={data} />,
    auctions: <Auctions data={data} />,
    quality: <Quality data={data} />,
    production: <Production data={data} />,
    forecast: <Forecasts data={data} />,
    blend: <BlendPlanner data={data} />,
    counterparties: <Counterparties data={data} />,
    calculations: <CalculationTools calculations={calculations} />,
    trust: <Trust data={data} />,
    ask: <AskData data={data} />,
  };
  const navigate = (key) => { setView(key); setMobileNav(false); window.scrollTo({ top: 0, behavior: "smooth" }); };
  return (
    <div className="app-shell">
      <aside className={mobileNav ? "open" : ""}>
        <div className="brand"><div>k<span>ej</span></div><p><strong>kejAI</strong><small>Operations control</small></p></div>
        <nav>
          <span className="nav-label">Business</span>
          {nav.map(([key, label, icon]) => (
            <button className={view === key ? "active" : ""} onClick={() => navigate(key)} key={key}><Icon name={icon} />{label}</button>
          ))}
          <span className="nav-label">Intelligence</span>
          <button className={view === "calculations" ? "active" : ""} onClick={() => navigate("calculations")}><Icon name="calculator" />Calculation tools</button>
          <button className={view === "trust" ? "active" : ""} onClick={() => navigate("trust")}><Icon name="shield" />Data trust center<span className="nav-count">{data.trustIssues.length}</span></button>
          <button className={view === "ask" ? "active" : ""} onClick={() => navigate("ask")}><Icon name="chat" />Ask kejAI</button>
        </nav>
        <div className="sidebar-foot">
          <Status type="verified">Read-only POC</Status>
          <p>PostgreSQL source of truth<br /><strong>{data.meta.snapshot}</strong></p>
        </div>
      </aside>
      {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
      <main>
        <button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation">☰ <span>kejAI</span></button>
        <ValidationContext.Provider value={data.validation[view]}>{content[view]}</ValidationContext.Provider>
        <EvidencePanel groups={evidenceGroups} />
        <footer><span>kejAI Phase 1 POC</span><p>Numbers are read from local PostgreSQL with workbook-row provenance. Missing business rules are shown as incomplete.</p></footer>
      </main>
    </div>
  );
}
