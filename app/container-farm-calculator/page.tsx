"use client";

import React, { useEffect, useMemo, useState } from "react";

type Money = number;

function rub(n: number) {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(n);
}

function num(n: number) {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
}

function clampNonNeg(x: number) {
  return Number.isFinite(x) ? Math.max(0, x) : 0;
}

function parseNumber(v: string, fallback: number) {
  const x = Number(String(v).replace(",", "."));
  return Number.isFinite(x) ? x : fallback;
}

// Ставки и допущения по РФ (актуально на март 2026)
const TAX_RATES_RF_2026 = {
  usnIncome: 0.06,           // УСН «доходы» — ст. 346.20 НК РФ
  usnIncomeMinusExpense: 0.15, // УСН «доходы − расходы»
  usnMinTaxPct: 0.01,         // Минимальный налог при УСН 15% — 1% от доходов
  profitTax: 0.2,             // Налог на прибыль организаций — ст. 284 НК РФ
  vatBase: 22,                // НДС базовая ставка с 01.01.2026 (была 20%)
  payrollTaxes: 0.3,          // Страховые взносы (до предельной базы) — ~30%
} as const;

// --- Расчёт помесячных денежных потоков с учётом всех факторов ---
type CalcParams = {
  containers: number;
  yieldKgPerMonth: number;
  pricePerKg: number;
  energyPricingMode: "perHourContainer" | "perKwh";
  powerKw: number;
  hoursPerDay: number;
  energyRubPerHourContainer: number;
  energyRubPerKwh: number;
  workers: number;
  salaryRubPerMonth: number;
  payrollTaxesPct: number;
  seedsAndConsumablesRubPerKg: number;
  packagingRubPerKg: number;
  logisticsRubPerMonth: number;
  rentAndOtherRubPerMonth: number;
  maintenanceRubPerMonth: number;
  containerCapexRub: number;
  installationRub: number;
  workingCapitalRub: number;
  taxRegime: "usn6" | "usn15" | "osno";
  vatPct: number;
  amortMonths: number;
  financingType: "equity" | "loan" | "leasing";
  loanPct: number;
  loanRateAnnualPct: number;
  loanMonths: number;
  leasingPaymentsPerMonth: number;
  seasonalityCoeffs: number[];
  priceGrowthAnnualPct: number;
  yieldGrowthAnnualPct: number;
  downtimePct: number;
  lossPct: number;
};

type MonthRow = {
  month: number;
  revenue: Money;
  opex: Money;
  depreciation: Money;
  ebit: Money;
  interest: Money;
  taxBase: Money;
  tax: Money;
  netProfit: Money;
  cashflow: Money;
  cumulative: Money;
  cumulativeAfterCapex: Money;
};

function calcMonthlyRows(
  p: CalcParams,
  months: number
): MonthRow[] {
  const daysPerMonth = 30;
  const priceGrowthMonthly = Math.pow(1 + p.priceGrowthAnnualPct / 100, 1 / 12);
  const yieldGrowthMonthly = Math.pow(1 + p.yieldGrowthAnnualPct / 100, 1 / 12);
  const availability = (1 - p.downtimePct / 100) * (1 - p.lossPct / 100);

  const capexTotal = p.containers * (p.containerCapexRub + p.installationRub) + p.workingCapitalRub;

  // Заём: доля financing, процент, срок
  const loanAmount = p.financingType === "loan" ? capexTotal * (p.loanPct / 100) : 0;
  const rMonthly = p.financingType === "loan" ? (p.loanRateAnnualPct / 100) / 12 : 0;
  const annuityFactor = rMonthly > 0 ? (rMonthly * Math.pow(1 + rMonthly, p.loanMonths)) / (Math.pow(1 + rMonthly, p.loanMonths) - 1) : 0;
  const monthlyLoanPayment = loanAmount * annuityFactor;

  const deprecPerMonth = p.amortMonths > 0 ? (p.containers * (p.containerCapexRub + p.installationRub)) / p.amortMonths : 0;
  const leasingPerMonth = p.financingType === "leasing" ? p.containers * p.leasingPaymentsPerMonth : 0;

  const rows: MonthRow[] = [];
  let cum = 0;
  let balance = loanAmount;

  for (let m = 1; m <= months; m++) {
    const seasonCoef = p.seasonalityCoeffs[(m - 1) % 12] ?? 1;
    const effYield = p.containers * p.yieldKgPerMonth * availability * seasonCoef * Math.pow(yieldGrowthMonthly, m - 1);
    const effPrice = p.pricePerKg * Math.pow(priceGrowthMonthly, m - 1) * seasonCoef;
    const revenueGross = effYield * effPrice;

    const energyCost =
      p.energyPricingMode === "perHourContainer"
        ? p.containers * p.energyRubPerHourContainer * p.hoursPerDay * daysPerMonth
        : p.containers * p.energyRubPerKwh * p.powerKw * p.hoursPerDay * daysPerMonth;

    const payrollBase = p.containers * p.workers * p.salaryRubPerMonth;
    const payrollTaxes = payrollBase * (p.payrollTaxesPct / 100);
    const payrollTotal = payrollBase + payrollTaxes;

    const consumables = effYield * p.seedsAndConsumablesRubPerKg;
    const packaging = effYield * p.packagingRubPerKg;
    const otherOpex = p.containers * (p.logisticsRubPerMonth + p.rentAndOtherRubPerMonth + p.maintenanceRubPerMonth);

    let opex = energyCost + payrollTotal + consumables + packaging + otherOpex + leasingPerMonth;

    let interest = 0;
    if (p.financingType === "loan" && balance > 0) {
      interest = balance * rMonthly;
      balance = Math.max(0, balance - (monthlyLoanPayment - interest));
    }

    const depreciation = m <= p.amortMonths ? deprecPerMonth : 0;
    const ebit = revenueGross - opex - depreciation;

    let taxBase = 0;
    let tax = 0;
    if (p.taxRegime === "usn6") {
      taxBase = revenueGross;
      tax = taxBase * TAX_RATES_RF_2026.usnIncome;
    } else if (p.taxRegime === "usn15") {
      taxBase = Math.max(0, revenueGross - opex - depreciation);
      const regularTax = taxBase * TAX_RATES_RF_2026.usnIncomeMinusExpense;
      const minTax = revenueGross * TAX_RATES_RF_2026.usnMinTaxPct; // НК РФ ст. 346.18
      tax = Math.max(regularTax, minTax);
    } else {
      taxBase = Math.max(0, ebit - interest);
      tax = taxBase * TAX_RATES_RF_2026.profitTax;
    }

    const netProfit = ebit - interest - tax;
    const cashflow = netProfit + depreciation - (p.financingType === "loan" ? monthlyLoanPayment - interest : 0);

    cum += cashflow;
    rows.push({
      month: m,
      revenue: revenueGross,
      opex,
      depreciation,
      ebit,
      interest,
      taxBase,
      tax,
      netProfit,
      cashflow,
      cumulative: cum,
      cumulativeAfterCapex: cum - capexTotal,
    });
  }
  return rows;
}

function calcPaybackMonths(capex: Money, monthlyCashflows: number[]): number | null {
  if (capex <= 0) return 0;
  let cum = 0;
  for (let m = 0; m < monthlyCashflows.length; m++) {
    cum += monthlyCashflows[m];
    if (cum >= capex) return m + 1;
  }
  return null;
}

function calcNPV(capex: Money, cashflows: number[], discountRateAnnual: number): number {
  const r = discountRateAnnual / 12;
  let npv = -capex;
  for (let t = 0; t < cashflows.length; t++) {
    npv += cashflows[t] / Math.pow(1 + r, t + 1);
  }
  return npv;
}

const MONTH_NAMES = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export default function Page() {
  const [energyPricingMode, setEnergyPricingMode] = useState<"perHourContainer" | "perKwh">("perHourContainer");
  const [containers, setContainers] = useState<number>(1);

  const [yieldKgPerMonth, setYieldKgPerMonth] = useState<number>(300);
  const [pricePerKg, setPricePerKg] = useState<number>(1200);

  const [powerKw, setPowerKw] = useState<number>(14);
  const [hoursPerDay, setHoursPerDay] = useState<number>(18);
  const [energyRubPerHourContainer, setEnergyRubPerHourContainer] = useState<number>(150);
  const [energyRubPerKwh, setEnergyRubPerKwh] = useState<number>(8);

  const [workers, setWorkers] = useState<number>(1);
  const [salaryRubPerMonth, setSalaryRubPerMonth] = useState<number>(120_000);
  const [payrollTaxesPct, setPayrollTaxesPct] = useState<number>(30);

  const [seedsAndConsumablesRubPerKg, setSeedsAndConsumablesRubPerKg] = useState<number>(80);
  const [packagingRubPerKg, setPackagingRubPerKg] = useState<number>(40);
  const [logisticsRubPerMonth, setLogisticsRubPerMonth] = useState<number>(30_000);
  const [rentAndOtherRubPerMonth, setRentAndOtherRubPerMonth] = useState<number>(20_000);
  const [maintenanceRubPerMonth, setMaintenanceRubPerMonth] = useState<number>(15_000);

  const [containerCapexRub, setContainerCapexRub] = useState<number>(6_500_000);
  const [installationRub, setInstallationRub] = useState<number>(350_000);
  const [workingCapitalRub, setWorkingCapitalRub] = useState<number>(200_000);

  const [taxRegime, setTaxRegime] = useState<"usn6" | "usn15" | "osno">("usn6");
  const [vatPct, setVatPct] = useState<number>(TAX_RATES_RF_2026.vatBase);
  const [amortMonths, setAmortMonths] = useState<number>(84);

  const [financingType, setFinancingType] = useState<"equity" | "loan" | "leasing">("equity");
  const [loanPct, setLoanPct] = useState<number>(70);
  const [loanRateAnnualPct, setLoanRateAnnualPct] = useState<number>(18);
  const [loanMonths, setLoanMonths] = useState<number>(60);
  const [leasingPaymentsPerMonth, setLeasingPaymentsPerMonth] = useState<number>(120_000);

  const [seasonalityMode, setSeasonalityMode] = useState<"none" | "winter_low" | "summer_high" | "custom">("none");
  const [seasonalityCoeffs, setSeasonalityCoeffs] = useState<number[]>(Array(12).fill(1));
  const [priceGrowthAnnualPct, setPriceGrowthAnnualPct] = useState<number>(0);
  const [yieldGrowthAnnualPct, setYieldGrowthAnnualPct] = useState<number>(0);

  const [downtimePct, setDowntimePct] = useState<number>(0);
  const [lossPct, setLossPct] = useState<number>(5);

  const [discountRateAnnualPct, setDiscountRateAnnualPct] = useState<number>(18);
  const [monthsForNpv, setMonthsForNpv] = useState<number>(36);
  const [tornadoRangePct, setTornadoRangePct] = useState<number>(20);

  const areaM2 = 90;

  const params: CalcParams = useMemo(
    () => ({
      containers: clampNonNeg(containers),
      yieldKgPerMonth: clampNonNeg(yieldKgPerMonth),
      pricePerKg: clampNonNeg(pricePerKg),
      energyPricingMode,
      powerKw: clampNonNeg(powerKw),
      hoursPerDay: clampNonNeg(hoursPerDay),
      energyRubPerHourContainer: clampNonNeg(energyRubPerHourContainer),
      energyRubPerKwh: clampNonNeg(energyRubPerKwh),
      workers: clampNonNeg(workers),
      salaryRubPerMonth: clampNonNeg(salaryRubPerMonth),
      payrollTaxesPct: clampNonNeg(payrollTaxesPct),
      seedsAndConsumablesRubPerKg: clampNonNeg(seedsAndConsumablesRubPerKg),
      packagingRubPerKg: clampNonNeg(packagingRubPerKg),
      logisticsRubPerMonth: clampNonNeg(logisticsRubPerMonth),
      rentAndOtherRubPerMonth: clampNonNeg(rentAndOtherRubPerMonth),
      maintenanceRubPerMonth: clampNonNeg(maintenanceRubPerMonth),
      containerCapexRub: clampNonNeg(containerCapexRub),
      installationRub: clampNonNeg(installationRub),
      workingCapitalRub: clampNonNeg(workingCapitalRub),
      taxRegime,
      vatPct: clampNonNeg(vatPct),
      amortMonths: clampNonNeg(amortMonths),
      financingType,
      loanPct: clampNonNeg(loanPct),
      loanRateAnnualPct: clampNonNeg(loanRateAnnualPct),
      loanMonths: clampNonNeg(loanMonths),
      leasingPaymentsPerMonth: clampNonNeg(leasingPaymentsPerMonth),
      seasonalityCoeffs: (() => {
        if (seasonalityMode === "none") return Array(12).fill(1);
        if (seasonalityMode === "winter_low")
          return [0.7, 0.75, 0.85, 1, 1.1, 1.15, 1.15, 1.1, 1, 0.9, 0.8, 0.75];
        if (seasonalityMode === "summer_high")
          return [0.9, 0.85, 0.95, 1.05, 1.2, 1.25, 1.25, 1.2, 1.05, 0.95, 0.9, 0.95];
        return seasonalityCoeffs;
      })(),
      priceGrowthAnnualPct: clampNonNeg(priceGrowthAnnualPct),
      yieldGrowthAnnualPct: clampNonNeg(yieldGrowthAnnualPct),
      downtimePct: clampNonNeg(downtimePct),
      lossPct: clampNonNeg(lossPct),
    }),
    [
      containers,
      yieldKgPerMonth,
      pricePerKg,
      energyPricingMode,
      powerKw,
      hoursPerDay,
      energyRubPerHourContainer,
      energyRubPerKwh,
      workers,
      salaryRubPerMonth,
      payrollTaxesPct,
      seedsAndConsumablesRubPerKg,
      packagingRubPerKg,
      logisticsRubPerMonth,
      rentAndOtherRubPerMonth,
      maintenanceRubPerMonth,
      containerCapexRub,
      installationRub,
      workingCapitalRub,
      taxRegime,
      vatPct,
      amortMonths,
      financingType,
      loanPct,
      loanRateAnnualPct,
      loanMonths,
      leasingPaymentsPerMonth,
      seasonalityMode,
      seasonalityCoeffs,
      priceGrowthAnnualPct,
      yieldGrowthAnnualPct,
      downtimePct,
      lossPct,
    ]
  );

  const timeline = useMemo(
    () => calcMonthlyRows(params, Math.max(12, monthsForNpv)),
    [params, monthsForNpv]
  );

  const metrics = useMemo(() => {
    const capexTotal =
      params.containers * (params.containerCapexRub + params.installationRub) + params.workingCapitalRub;
    const cashflows = timeline.map((r) => r.cashflow);
    const avgMonthlyCashflow = cashflows.length > 0 ? cashflows.reduce((a, b) => a + b, 0) / cashflows.length : 0;
    const paybackMonths = calcPaybackMonths(capexTotal, cashflows);
    const annualCashflow = cashflows.slice(0, 12).reduce((a, b) => a + b, 0);
    const roiAnnual = capexTotal > 0 ? annualCashflow / capexTotal : null;
    const npv = calcNPV(
      capexTotal,
      cashflows.slice(0, monthsForNpv),
      clampNonNeg(discountRateAnnualPct) / 100
    );

    const firstYear = timeline.filter((r) => r.month <= 12);
    const totalRev = firstYear.reduce((a, r) => a + r.revenue, 0);
    const totalOpex = firstYear.reduce((a, r) => a + r.opex, 0);
    const totalTax = firstYear.reduce((a, r) => a + r.tax, 0);
    const totalCashflow = firstYear.reduce((a, r) => a + r.cashflow, 0);

    return {
      capexTotal,
      paybackMonths,
      roiAnnual,
      npv,
      avgMonthlyCashflow,
      firstYearRevenue: totalRev,
      firstYearOpex: totalOpex,
      firstYearTax: totalTax,
      firstYearCashflow: totalCashflow,
      marginPct: totalRev > 0 ? ((totalRev - totalOpex) / totalRev) * 100 : 0,
    };
  }, [timeline, params, monthsForNpv, discountRateAnnualPct]);

  // Tornado: анализ чувствительности NPV. Для каждого параметра варьируем ±tornadoRangePct% и смотрим, как меняется NPV относительно базового.
  // lowMult/highMult: множитель для параметра. Для выручки: low=хуже (0.8), high=лучше (1.2). Для затрат: наоборот.
  const tornadoData = useMemo(() => {
    const baseNPV = metrics.npv;
    const range = tornadoRangePct / 100;
    const variations: Array<{ param: string; low: number; high: number; lowLabel: string; highLabel: string }> = [];

    const vary = (key: keyof CalcParams, lowMult: number, highMult: number, lowLabel: string, highLabel: string) => {
      if (typeof params[key] !== "number") return;
      const pLow = { ...params, [key]: (params[key] as number) * lowMult } as CalcParams;
      const pHigh = { ...params, [key]: (params[key] as number) * highMult } as CalcParams;
      const rowsLow = calcMonthlyRows(pLow, monthsForNpv);
      const rowsHigh = calcMonthlyRows(pHigh, monthsForNpv);
      const capexLow = pLow.containers * (pLow.containerCapexRub + pLow.installationRub) + pLow.workingCapitalRub;
      const capexHigh = pHigh.containers * (pHigh.containerCapexRub + pHigh.installationRub) + pHigh.workingCapitalRub;
      const npvLow = calcNPV(capexLow, rowsLow.map((r) => r.cashflow), discountRateAnnualPct / 100);
      const npvHigh = calcNPV(capexHigh, rowsHigh.map((r) => r.cashflow), discountRateAnnualPct / 100);
      variations.push({
        param: key,
        low: npvLow - baseNPV,
        high: npvHigh - baseNPV,
        lowLabel,
        highLabel,
      });
    };

    const r = tornadoRangePct;
    vary("pricePerKg", 1 - range, 1 + range, `−${r}%`, `+${r}%`);
    vary("yieldKgPerMonth", 1 - range, 1 + range, `−${r}%`, `+${r}%`);
    vary("containerCapexRub", 1 + range, 1 - range, `+${r}%`, `−${r}%`);
    vary(params.energyPricingMode === "perKwh" ? "energyRubPerKwh" : "energyRubPerHourContainer", 1 + range, 1 - range, `+${r}%`, `−${r}%`);
    vary("salaryRubPerMonth", 1 + range, 1 - range, `+${r}%`, `−${r}%`);
    vary("containers", 1 - range, 1 + range, `−${r}%`, `+${r}%`);

    return variations
      .sort((a, b) => Math.max(Math.abs(a.low), Math.abs(a.high)) - Math.max(Math.abs(b.low), Math.abs(b.high)))
      .reverse();
  }, [params, metrics.npv, monthsForNpv, discountRateAnnualPct, tornadoRangePct]);

  const paramLabels: Record<string, string> = {
    pricePerKg: "Цена за кг",
    yieldKgPerMonth: "Урожайность",
    containerCapexRub: "CAPEX контейнера",
    energyRubPerKwh: "Тариф энергии (кВт⋅ч)",
    energyRubPerHourContainer: "Тариф энергии (час)",
    salaryRubPerMonth: "Зарплата",
    containers: "Кол-во контейнеров",
  };

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
      <h1 style={{ fontSize: 26, margin: 0 }}>Калькулятор: контейнер-ферма (расширенный)</h1>
      <p style={{ marginTop: 8, color: "#444", fontSize: 14 }}>
        Показатели приведены к законодательству РФ (актуально на март 2026). Налоги, амортизация, кредит/лизинг, сезонность, рост, простои, потери, multi-container, tornado.
      </p>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 18 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16, maxHeight: "90vh", overflowY: "auto" }}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Параметры</h2>

          <Collapse title="Производство и выручка">
            <Field label="Контейнеров" value={String(containers)} onChange={(v) => setContainers(parseNumber(v, 1))} hint="Парк" />
            <Field label="Выход (кг/мес на контейнер)" value={String(yieldKgPerMonth)} onChange={(v) => setYieldKgPerMonth(parseNumber(v, 300))} />
            <Field label="Цена (руб/кг)" value={String(pricePerKg)} onChange={(v) => setPricePerKg(parseNumber(v, 1200))} />
            <Field label="Простои (%)" value={String(downtimePct)} onChange={(v) => setDowntimePct(parseNumber(v, 0))} hint="Не работаем" />
            <Field label="Потери урожая (%)" value={String(lossPct)} onChange={(v) => setLossPct(parseNumber(v, 5))} />
          </Collapse>

          <Collapse title="Рост">
            <Field label="Рост цены (% год)" value={String(priceGrowthAnnualPct)} onChange={(v) => setPriceGrowthAnnualPct(parseNumber(v, 0))} />
            <Field label="Рост урожайности (% год)" value={String(yieldGrowthAnnualPct)} onChange={(v) => setYieldGrowthAnnualPct(parseNumber(v, 0))} />
          </Collapse>

          <Collapse title="Сезонность">
            <div style={{ marginBottom: 8 }}>
              <select
                value={seasonalityMode}
                onChange={(e) => setSeasonalityMode(e.target.value as typeof seasonalityMode)}
                style={{ padding: 8, borderRadius: 8, width: "100%" }}
              >
                <option value="none">Нет</option>
                <option value="winter_low">Зима ниже</option>
                <option value="summer_high">Лето выше</option>
                <option value="custom">Свои коэфф.</option>
              </select>
            </div>
            {seasonalityMode === "custom" && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6 }}>
                {MONTH_NAMES.map((name, i) => (
                  <div key={i}>
                    <div style={{ fontSize: 10 }}>{name}</div>
                    <input
                      value={seasonalityCoeffs[i] ?? 1}
                      onChange={(e) => {
                        const arr = [...seasonalityCoeffs];
                        arr[i] = parseNumber(e.target.value, 1);
                        setSeasonalityCoeffs(arr);
                      }}
                      style={{ width: "100%", padding: 4 }}
                    />
                  </div>
                ))}
              </div>
            )}
          </Collapse>

          <Collapse title="Энергия">
            <div style={{ marginBottom: 8 }}>
              <label><input type="radio" checked={energyPricingMode === "perHourContainer"} onChange={() => setEnergyPricingMode("perHourContainer")} /> руб/час</label>
              <label style={{ marginLeft: 12 }}><input type="radio" checked={energyPricingMode === "perKwh"} onChange={() => setEnergyPricingMode("perKwh")} /> руб/кВт⋅ч</label>
            </div>
            <Field label="Мощность (кВт)" value={String(powerKw)} onChange={(v) => setPowerKw(parseNumber(v, 14))} />
            <Field label="Часов/сутки" value={String(hoursPerDay)} onChange={(v) => setHoursPerDay(parseNumber(v, 18))} />
            {energyPricingMode === "perHourContainer" ? (
              <Field label="Тариф (руб/час)" value={String(energyRubPerHourContainer)} onChange={(v) => setEnergyRubPerHourContainer(parseNumber(v, 150))} />
            ) : (
              <Field label="Тариф (руб/кВт⋅ч)" value={String(energyRubPerKwh)} onChange={(v) => setEnergyRubPerKwh(parseNumber(v, 8))} />
            )}
          </Collapse>

          <Collapse title="Труд">
            <Field label="Сотрудников на контейнер" value={String(workers)} onChange={(v) => setWorkers(parseNumber(v, 1))} />
            <Field label="Зарплата (руб/мес)" value={String(salaryRubPerMonth)} onChange={(v) => setSalaryRubPerMonth(parseNumber(v, 120000))} />
            <Field label="Начисления на ФОТ (%)" value={String(payrollTaxesPct)} onChange={(v) => setPayrollTaxesPct(parseNumber(v, 30))} hint="Страховые взносы ~30% до предельной базы (2026)" />
          </Collapse>

          <Collapse title="Прочий OPEX">
            <Field label="Расходники (руб/кг)" value={String(seedsAndConsumablesRubPerKg)} onChange={(v) => setSeedsAndConsumablesRubPerKg(parseNumber(v, 80))} />
            <Field label="Упаковка (руб/кг)" value={String(packagingRubPerKg)} onChange={(v) => setPackagingRubPerKg(parseNumber(v, 40))} />
            <Field label="Логистика (руб/мес на контейнер)" value={String(logisticsRubPerMonth)} onChange={(v) => setLogisticsRubPerMonth(parseNumber(v, 30000))} />
            <Field label="Аренда/прочее (руб/мес)" value={String(rentAndOtherRubPerMonth)} onChange={(v) => setRentAndOtherRubPerMonth(parseNumber(v, 20000))} />
            <Field label="Обслуживание (руб/мес)" value={String(maintenanceRubPerMonth)} onChange={(v) => setMaintenanceRubPerMonth(parseNumber(v, 15000))} />
          </Collapse>

          <Collapse title="CAPEX">
            <Field label="Контейнер (руб)" value={String(containerCapexRub)} onChange={(v) => setContainerCapexRub(parseNumber(v, 6500000))} />
            <Field label="Монтаж (руб)" value={String(installationRub)} onChange={(v) => setInstallationRub(parseNumber(v, 350000))} />
            <Field label="Оборотный капитал (руб)" value={String(workingCapitalRub)} onChange={(v) => setWorkingCapitalRub(parseNumber(v, 200000))} />
          </Collapse>

          <Collapse title="Налоги и амортизация">
            <div style={{ marginBottom: 8 }}>
              <select value={taxRegime} onChange={(e) => setTaxRegime(e.target.value as typeof taxRegime)} style={{ padding: 8, borderRadius: 8, width: "100%" }}>
                <option value="usn6">УСН 6% (доходы) — ст. 346.20 НК РФ</option>
                <option value="usn15">УСН 15% (доходы − расходы), мин. 1% — ст. 346.18</option>
                <option value="osno">ОСНО (налог на прибыль 20%) — ст. 284 НК РФ</option>
              </select>
            </div>
            <Field label="НДС (% для отображения)" value={String(vatPct)} onChange={(v) => setVatPct(parseNumber(v, TAX_RATES_RF_2026.vatBase))} hint="Базовая ставка 22% с 01.01.2026 (НК РФ ст. 164)" />
            <Field label="Амортизация (мес)" value={String(amortMonths)} onChange={(v) => setAmortMonths(parseNumber(v, 84))} hint="СПИ оборудования (линейный метод), напр. 84 мес = 7 лет" />
          </Collapse>

          <Collapse title="Финансирование">
            <div style={{ marginBottom: 8 }}>
              <label><input type="radio" checked={financingType === "equity"} onChange={() => setFinancingType("equity")} /> Собственные</label>
              <label style={{ marginLeft: 12 }}><input type="radio" checked={financingType === "loan"} onChange={() => setFinancingType("loan")} /> Кредит</label>
              <label style={{ marginLeft: 12 }}><input type="radio" checked={financingType === "leasing"} onChange={() => setFinancingType("leasing")} /> Лизинг</label>
            </div>
            {financingType === "loan" && (
              <>
                <Field label="Доля заёмных (%)" value={String(loanPct)} onChange={(v) => setLoanPct(parseNumber(v, 70))} />
                <Field label="Ставка кредита (% год)" value={String(loanRateAnnualPct)} onChange={(v) => setLoanRateAnnualPct(parseNumber(v, 18))} />
                <Field label="Срок кредита (мес)" value={String(loanMonths)} onChange={(v) => setLoanMonths(parseNumber(v, 60))} />
              </>
            )}
            {financingType === "leasing" && (
              <Field label="Платёж лизинга (руб/мес на контейнер)" value={String(leasingPaymentsPerMonth)} onChange={(v) => setLeasingPaymentsPerMonth(parseNumber(v, 120000))} />
            )}
          </Collapse>

          <Collapse title="NPV и Tornado">
            <Field label="Ставка дисконтирования (% год)" value={String(discountRateAnnualPct)} onChange={(v) => setDiscountRateAnnualPct(parseNumber(v, 18))} />
            <Field label="Горизонт (мес)" value={String(monthsForNpv)} onChange={(v) => setMonthsForNpv(parseNumber(v, 36))} />
            <Field label="Tornado: ±% вариации" value={String(tornadoRangePct)} onChange={(v) => setTornadoRangePct(parseNumber(v, 20))} />
          </Collapse>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16, maxHeight: "90vh", overflowY: "auto" }}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Результаты</h2>

          <KpiGrid
            items={[
              { title: "CAPEX", value: rub(metrics.capexTotal), sub: `${containers} контейнеров` },
              { title: "Окупаемость", value: metrics.paybackMonths === null ? "—" : `${num(metrics.paybackMonths)} мес`, sub: "" },
              { title: "ROI (1‑й год)", value: metrics.roiAnnual === null ? "—" : `${num(metrics.roiAnnual * 100)}%`, sub: "" },
              { title: "NPV", value: rub(metrics.npv), sub: `${monthsForNpv} мес, ${discountRateAnnualPct}%` },
              { title: "Выручка (1‑й год)", value: rub(metrics.firstYearRevenue), sub: "" },
              { title: "OPEX (1‑й год)", value: rub(metrics.firstYearOpex), sub: "" },
              { title: "Налоги (1‑й год)", value: rub(metrics.firstYearTax), sub: "" },
              { title: "Денежный поток (1‑й год)", value: rub(metrics.firstYearCashflow), sub: "" },
            ]}
          />

          <h3 style={{ marginTop: 18 }}>Tornado: чувствительность NPV</h3>
          <p style={{ marginTop: 4, fontSize: 12, color: "#666" }}>
            Показано, как меняется NPV при отклонении каждого параметра на ±{tornadoRangePct}% от текущего. Слева — неблагоприятный сценарий (Δ к базовому NPV), справа — благоприятный. Параметры отсортированы по влиянию.
          </p>
          <TornadoChart data={tornadoData} paramLabels={paramLabels} rub={rub} />

          <h3 style={{ marginTop: 18 }}>Cash Flow (помесячно)</h3>
          <div style={{ overflowX: "auto", fontSize: 12 }}>
            <table style={{ borderCollapse: "collapse", minWidth: "max-content" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 10px", position: "sticky", left: 0, background: "#fff", minWidth: 140, zIndex: 1 }}>Показатель</th>
                  {timeline.map((r) => (
                    <th key={r.month} style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: "8px 8px", minWidth: 90 }}>{r.month}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { key: "revenue", label: "Выручка", fn: (r: MonthRow) => r.revenue },
                  { key: "opex", label: "OPEX", fn: (r: MonthRow) => r.opex },
                  { key: "depreciation", label: "Амортизация", fn: (r: MonthRow) => r.depreciation },
                  { key: "ebit", label: "EBIT", fn: (r: MonthRow) => r.ebit },
                  { key: "interest", label: "Проценты", fn: (r: MonthRow) => r.interest },
                  { key: "tax", label: "Налог", fn: (r: MonthRow) => r.tax },
                  { key: "netProfit", label: "Чистая прибыль", fn: (r: MonthRow) => r.netProfit },
                  { key: "cashflow", label: "Cash Flow", fn: (r: MonthRow) => r.cashflow },
                  { key: "cumulative", label: "Кумулятив CF", fn: (r: MonthRow) => r.cumulative },
                  { key: "cumulativeAfterCapex", label: "Кумулятив − CAPEX", fn: (r: MonthRow) => r.cumulativeAfterCapex },
                ].map(({ key, label, fn }) => (
                  <tr key={key}>
                    <td style={{ padding: "6px 10px", borderBottom: "1px solid #eee", position: "sticky", left: 0, background: "#fff", zIndex: 1, whiteSpace: "nowrap" }}>{label}</td>
                    {timeline.map((r) => (
                      <td key={r.month} style={{ padding: "6px 8px", borderBottom: "1px solid #eee", textAlign: "right" }}>{rub(fn(r))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}

function Collapse({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 12, border: "1px solid #eee", borderRadius: 8, overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          padding: "10px 12px",
          textAlign: "left",
          border: "none",
          background: "#f9fafb",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        {open ? "▼" : "▶"} {title}
      </button>
      {open && <div style={{ padding: 12, borderTop: "1px solid #eee", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{children}</div>}
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div style={{ gridColumn: props.label.length > 30 ? "1 / -1" : undefined }}>
      <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>{props.label}</div>
      <input
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        inputMode="decimal"
        style={{
          width: "100%",
          padding: "8px",
          borderRadius: 8,
          border: "1px solid #ddd",
          outline: "none",
          background: props.disabled ? "#fafafa" : "white",
        }}
      />
      {props.hint ? <div style={{ marginTop: 4, fontSize: 10, color: "#777" }}>{props.hint}</div> : null}
    </div>
  );
}

function TornadoChart(props: {
  data: Array<{ param: string; low: number; high: number; lowLabel: string; highLabel: string }>;
  paramLabels: Record<string, string>;
  rub: (n: number) => string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || props.data.length === 0) {
    return <div style={{ marginTop: 8, color: props.data.length === 0 ? "#777" : undefined, fontSize: 12 }}>{props.data.length === 0 ? "Нет данных" : "Загрузка…"}</div>;
  }

  const { data, paramLabels, rub } = props;
  const allVals = data.flatMap((t) => [t.low, t.high]);
  const scaleMin = Math.min(...allVals, 0);
  const scaleMax = Math.max(...allVals, 0);
  const range = Math.max(scaleMax - scaleMin, 1);
  return (
    <div style={{ marginTop: 8 }}>
      {data.map((t, i) => {
        const barLow = Math.min(t.low, t.high);
        const barHigh = Math.max(t.low, t.high);
        const leftLabel = t.low <= t.high ? t.lowLabel : t.highLabel;
        const rightLabel = t.low <= t.high ? t.highLabel : t.lowLabel;
        const leftPct = Math.round(((barLow - scaleMin) / range) * 10000) / 100;
        const widthPct = Math.round(((barHigh - barLow) / range) * 10000) / 100;
        const zeroPct = Math.round(((-scaleMin) / range) * 10000) / 100;
        return (
          <div key={i} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>{paramLabels[t.param] ?? t.param}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 95, fontSize: 11, color: "#666", textAlign: "right" }}>
                <div>{leftLabel}</div>
                <div style={{ fontWeight: 500 }}>{rub(barLow)}</div>
              </div>
              <div style={{ flex: 1, height: 24, background: "#eee", borderRadius: 4, position: "relative" }}>
                <div style={{ position: "absolute" as const, left: `${zeroPct}%`, top: "0", bottom: "0", width: "1px", backgroundColor: "#333" }} />
                <div
                  style={{
                    position: "absolute" as const,
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    top: "2px",
                    bottom: "2px",
                    background: barLow < 0 && barHigh > 0 ? "linear-gradient(to right, #dc2626, #fbbf24 50%, #059669)" : barLow >= 0 ? "#059669" : "#dc2626",
                    borderRadius: "2px",
                  }}
                />
              </div>
              <div style={{ width: 95, fontSize: 11, color: "#666" }}>
                <div>{rightLabel}</div>
                <div style={{ fontWeight: 500 }}>{rub(barHigh)}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KpiGrid(props: { items: Array<{ title: string; value: string; sub?: string }> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
      {props.items.map((x) => (
        <div key={x.title} style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 11, color: "#666" }}>{x.title}</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{x.value}</div>
          {x.sub ? <div style={{ fontSize: 11, color: "#777", marginTop: 4 }}>{x.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
