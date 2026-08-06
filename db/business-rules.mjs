// Single source of truth for business knowledge: definitions, formulas and known
// data gaps. Loaded into governance.calculation_rule by scripts/load-business-rules.mjs
// and injected into the Ask kejAI agent at request time (lib/rules.mjs).
//
// Sources: "KEJ AI – Business Calculation Validation Questionnaire" answered by the
// client (Aug 2026), and internal definitions pending client confirmation.
// GAP_* rules describe data that is missing; the agent must answer Incomplete and
// name the gap instead of guessing. status "draft" rules are NOT shown to the agent.

const CLIENT = "KEJ questionnaire (Aug 2026)";
const INTERNAL = "kejAI internal (pending client confirmation)";
const AUDIT = "kejAI data audit (Aug 2026)";

export const businessRules = [
  {
    code: "LANDED_COST", version: 2, status: "approved", approvedBy: CLIENT,
    definition: "Landed cost per MT = final purchase price + royalty + DMF + NMET + actual inward transportation + loading charges + trip-sheet charge (forest-area mines only) + miscellaneous expenses. GST is excluded. Divide total cost by purchased quantity (not received or usable quantity). Typical fixed components: loading Rs 50/MT, mine transportation about Rs 520/MT, trip sheet Rs 15 or Rs 12/MT, miscellaneous Rs 20/MT. Authoritative source: Inward Report.",
  },
  {
    code: "ROYALTY_DMF_NMET", version: 1, status: "approved", approvedBy: CLIENT,
    definition: "Royalty, DMF and NMET are calculated on the IBM Average Sale Price (the last ASP declared before the payment date): Royalty = 15% of ASP, DMF = 30% of the royalty, NMET = 3% of the royalty.",
  },
  {
    code: "WEIGHTED_QUALITY", version: 2, status: "approved", approvedBy: CLIENT,
    definition: "Weighted Fe and other quality averages are quantity-weighted over Available Quantity using the receiving grade declared by the KEJ lab. If a selected lot has no quality report, highlight it and request results on priority. Display Fe, Al2O3 and SiO2 to 2 decimal places and Phosphorus to 3.",
  },
  {
    code: "PRODUCTION_RECOVERY", version: 2, status: "approved", approvedBy: CLIENT,
    definition: "Recovery % = useful output / feed quantity x 100. Useful output for fines = all products except tailings; for lumps = processed lumps plus fines. Iron recovery is also tracked using quantity x Fe. Any increase in moisture % is deducted from output quantity. Tailings, middlings, spillage and cleanings are reported separately. Authoritative source: the plant production report.",
  },
  {
    code: "STOCK_BALANCE", version: 2, status: "approved", approvedBy: CLIENT,
    definition: "Closing stock = previous stock + lots purchased yesterday + lots produced yesterday - lots dispatched yesterday - material fed to production. Purchased lots not yet received at the plant are included, categorised paid and unpaid. Stock reserved for a customer or production plan is excluded from available stock and shown separately. Shortage or moisture loss is concluded only when a lot is fully consumed or weighed in a stock audit. The HO Stock Report is the single final stock report.",
  },
  {
    code: "PENDING_PAYMENT", version: 1, status: "approved", approvedBy: CLIENT,
    definition: "Pending payment for a lot = lot quantity x (purchase price + royalty + DMF + NMET + loading charges).",
  },
  {
    code: "PAYMENT_STATUS", version: 1, status: "approved", approvedBy: CLIENT,
    definition: "Paid = payment clear, material can be lifted. Partly Paid = part payment made, balance paid once lifting permission is received. Unpaid = lot purchased but no payment made. Payment Returned = material rejected on quality and the balance for the un-lifted lot refunded. 'Payment Done' always means fully paid. The Inward Report is the final payment record.",
  },
  {
    code: "CUSTOMER_BONUS_PENALTY", version: 1, status: "approved", approvedBy: CLIENT,
    definition: "Customer bonus or penalty = (actual Fe received - Fe committed in the buyer's PO) x the mutually agreed value per Fe point. The rule differs per customer.",
  },
  {
    code: "PROFIT", version: 1, status: "approved", approvedBy: CLIENT,
    definition: "Profit deducts the material's landed cost to the plant, plus transportation cost when KEJ delivers to the buyer. The full expense breakdown (processing cost, other expenses) is not yet confirmed by the client.",
  },
  {
    code: "BLEND_MAX_PROFIT", version: 1, status: "approved", approvedBy: CLIENT,
    definition: "A maximum-profit blend maximises consumption of lower-cost material while matching the Fe required by the customer: the cheapest feasible mix that hits the target Fe, computed with the lever rule over the latest stock snapshot.",
  },
  {
    code: "BLEND_BALANCED", version: 1, status: "draft", approvedBy: INTERNAL,
    definition: "Internal draft: balance 60% cost efficiency with 40% stock-age priority. The client has not yet confirmed what a balanced blend should balance.",
  },
  {
    code: "OLD_STOCK", version: 1, status: "approved", approvedBy: CLIENT,
    definition: "Any lot available in the plant for more than 30 days is old stock and receives dispatch/blending priority.",
  },
  {
    code: "FASTEST_CUSTOMER", version: 1, status: "approved", approvedBy: INTERNAL,
    definition: "Fastest-moving customer = smallest average days from sales-order PO date to actual dispatch date, computed in SQL. Exclude, and mention excluding, dispatch rows dated before their PO date (bad PO dates).",
  },
  {
    code: "HIGHEST_BUYER", version: 1, status: "approved", approvedBy: INTERNAL,
    definition: "Highest buyer/customer by quantity = actual dispatched quantity, not ordered quantity, unless the user explicitly asks for orders. State the definition used.",
  },
  {
    code: "BEST_TRANSPORTER", version: 1, status: "approved", approvedBy: CLIENT,
    definition: "Best transporter = lifts material within the stipulated time at the lowest transportation cost, compared on rate, delivery time, shortage, quantity delivered and complaints. Rates are not comparable across different mines or routes. Work-order quantity is assigned quantity, never confirmed delivered quantity.",
  },
  {
    code: "GAP_PAYMENT_LEDGER", version: 1, status: "approved", approvedBy: AUDIT,
    definition: "No authoritative supplier payment ledger is loaded. Amounts owed or paid cannot be calculated; only reported payment statuses on purchase lots exist.",
  },
  {
    code: "GAP_DISPATCH_LOT", version: 1, status: "approved", approvedBy: AUDIT,
    definition: "Dispatch rows carry no KEJ lot linkage, so per-dispatch quality, cost and profit cannot be calculated until the outward report records lot numbers.",
  },
  {
    code: "GAP_DISPATCH_QUALITY", version: 1, status: "approved", approvedBy: AUDIT,
    definition: "No dispatch-stage Fe results exist, so delivered-versus-ordered Fe deviation and customer bonus/penalty amounts cannot be calculated.",
  },
  {
    code: "GAP_AUCTION_AWARDS", version: 1, status: "approved", approvedBy: AUDIT,
    definition: "Auction Bid Details rows are staged raw but not confirmed as a buyer-award source; competitor and customer auction-purchase analysis is unavailable until the client confirms that Allocated Quantity means awarded quantity.",
  },
  {
    code: "GAP_TRANSPORTER_DELIVERY", version: 1, status: "approved", approvedBy: AUDIT,
    definition: "Promised and actual delivery dates are not recorded, so transporter delivery performance cannot be ranked. Only assigned work-order quantities and rates are available.",
  },
  {
    code: "GAP_BEST_SUPPLIER", version: 1, status: "approved", approvedBy: AUDIT,
    definition: "'Best supplier' has no client-approved definition. Ask the user which criterion to use (lowest cost, highest quantity, best quality, timeliness) before answering.",
  },
];
