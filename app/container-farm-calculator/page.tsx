"use client";

import React, { useMemo, useState } from "react";

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

function calcPaybackMonths(capex: Money, monthlyProfit: Money): number | null {
  if (capex <= 0) return 0;
  if (monthlyProfit <= 0) return null;
  return capex / monthlyProfit;
}

function calcRoiAnnual(capex: Money, annualProfit: Money): number | null {
  if (capex <= 0) return null;
  return annualProfit / capex;
}

// Простая NPV (без налогов), ставка в год -> переводим в месяц
function calcNPV(capex: Money, monthlyCashflow: Money, months: number, discountRateAnnual: number): number {
  const r = discountRateAnnual / 12;
  let npv = -capex;
  for (let t = 1; t <= months; t++) {
    npv += monthlyCashflow / Math.pow(1 + r, t);
  }
  return npv;
}

export default function Page() {
  /**
   * Стартовые данные пользователя:
   * - "стоимость энергии 14 кВт на 18 часов 150 рублей в час"
   * Здесь трактуем как: мощность = 14 кВт, часов в сутки = 18,
   * тариф задан странно ("руб/час" вместо "руб/кВт⋅ч"), поэтому оставляем
   * ЯВНО как "рублей в час за весь контейнер".
   *
   * При желании можно переключиться на "руб/кВт⋅ч" (добавил тумблер).
   */
  const [energyPricingMode, setEnergyPricingMode] = useState<"perHourContainer" | "perKwh">("perHourContainer");

  // Производство / выручка
  const [yieldKgPerMonth, setYieldKgPerMonth] = useState<number>(300);
  const [pricePerKg, setPricePerKg] = useState<number>(1200);

  // Энергия
  const [powerKw, setPowerKw] = useState<number>(14);
  const [hoursPerDay, setHoursPerDay] = useState<number>(18);
  const [energyRubPerHourContainer, setEnergyRubPerHourContainer] = useState<number>(150); // руб/час контейнер
  const [energyRubPerKwh, setEnergyRubPerKwh] = useState<number>(8); // руб/кВт⋅ч (пример)

  // Труд
  const [workers, setWorkers] = useState<number>(1);
  const [salaryRubPerMonth, setSalaryRubPerMonth] = useState<number>(120_000); // поставил дефолт; меняется руками
  const [payrollTaxesPct, setPayrollTaxesPct] = useState<number>(30); // условно

  // Прочие расходы
  const [seedsAndConsumablesRubPerKg, setSeedsAndConsumablesRubPerKg] = useState<number>(80);
  const [packagingRubPerKg, setPackagingRubPerKg] = useState<number>(40);
  const [logisticsRubPerMonth, setLogisticsRubPerMonth] = useState<number>(30_000);
  const [rentAndOtherRubPerMonth, setRentAndOtherRubPerMonth] = useState<number>(20_000);
  const [maintenanceRubPerMonth, setMaintenanceRubPerMonth] = useState<number>(15_000);

  // CAPEX
  const [containerCapexRub, setContainerCapexRub] = useState<number>(6_500_000); // примерная величина, правь под реальность
  const [installationRub, setInstallationRub] = useState<number>(350_000);
  const [workingCapitalRub, setWorkingCapitalRub] = useState<number>(200_000);

  // Финансовые допущения
  const [discountRateAnnualPct, setDiscountRateAnnualPct] = useState<number>(18);
  const [monthsForNpv, setMonthsForNpv] = useState<number>(36);

  // Константы по задаче (информативно)
  const areaM2 = 90;

  const metrics = useMemo(() => {
    const y = clampNonNeg(yieldKgPerMonth);
    const p = clampNonNeg(pricePerKg);

    const revenue = y * p;

    // Energy cost:
    // mode A: руб/час за контейнер
    // mode B: руб/кВт⋅ч * кВт * часы * дни
    const daysPerMonth = 30; // упрощение
    const energyCost =
      energyPricingMode === "perHourContainer"
        ? clampNonNeg(energyRubPerHourContainer) * clampNonNeg(hoursPerDay) * daysPerMonth
        : clampNonNeg(energyRubPerKwh) * clampNonNeg(powerKw) * clampNonNeg(hoursPerDay) * daysPerMonth;

    const payrollBase = clampNonNeg(workers) * clampNonNeg(salaryRubPerMonth);
    const payrollTaxes = payrollBase * (clampNonNeg(payrollTaxesPct) / 100);
    const payrollTotal = payrollBase + payrollTaxes;

    const consumables = y * clampNonNeg(seedsAndConsumablesRubPerKg);
    const packaging = y * clampNonNeg(packagingRubPerKg);

    const otherOpex =
      clampNonNeg(logisticsRubPerMonth) +
      clampNonNeg(rentAndOtherRubPerMonth) +
      clampNonNeg(maintenanceRubPerMonth);

    const totalOpex = energyCost + payrollTotal + consumables + packaging + otherOpex;

    // EBITDA-like (без амортизации/налогов)
    const operatingProfit = revenue - totalOpex;

    const marginPct = revenue > 0 ? (operatingProfit / revenue) * 100 : 0;

    const capexTotal = clampNonNeg(containerCapexRub) + clampNonNeg(installationRub) + clampNonNeg(workingCapitalRub);

    const paybackMonths = calcPaybackMonths(capexTotal, operatingProfit);

    const annualProfit = operatingProfit * 12;
    const roiAnnual = calcRoiAnnual(capexTotal, annualProfit);

    const npv = calcNPV(capexTotal, operatingProfit, clampNonNeg(monthsForNpv), clampNonNeg(discountRateAnnualPct) / 100);

    // Unit economics
    const costPerKg = y > 0 ? totalOpex / y : 0;
    const profitPerKg = y > 0 ? operatingProfit / y : 0;

    return {
      revenue,
      energyCost,
      payrollTotal,
      consumables,
      packaging,
      otherOpex,
      totalOpex,
      operatingProfit,
      marginPct,
      capexTotal,
      paybackMonths,
      annualProfit,
      roiAnnual,
      npv,
      costPerKg,
      profitPerKg,
      daysPerMonth,
    };
  }, [
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
    discountRateAnnualPct,
    monthsForNpv,
  ]);

  const timeline = useMemo(() => {
    const rows: Array<{
      month: number;
      revenue: Money;
      opex: Money;
      operatingProfit: Money;
      cumulative: Money;
      cumulativeAfterCapex: Money;
    }> = [];

    let cum = 0;
    for (let m = 1; m <= 12; m++) {
      cum += metrics.operatingProfit;
      rows.push({
        month: m,
        revenue: metrics.revenue,
        opex: metrics.totalOpex,
        operatingProfit: metrics.operatingProfit,
        cumulative: cum,
        cumulativeAfterCapex: cum - metrics.capexTotal,
      });
    }
    return rows;
  }, [metrics]);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
      <h1 style={{ fontSize: 28, margin: 0 }}>Калькулятор: 40-футовый контейнер-ферма (базилик/зелень/плоды)</h1>
      <p style={{ marginTop: 8, color: "#444" }}>
        Входные параметры редактируются. Расчёты упрощённые (без НДС/налога на прибыль/амортизации), но удобны для быстрой инвестиционной оценки.
      </p>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 18 }}>
        {/* Inputs */}
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Исходные параметры</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field
              label="Площадь посевов (м²) — инфо"
              value={String(areaM2)}
              onChange={() => {}}
              disabled
              hint="Фиксировано из условия: 90 м² на контейнер"
            />

            <Field
              label="Выход продукции (кг/мес)"
              value={String(yieldKgPerMonth)}
              onChange={(v) => setYieldKgPerMonth(parseNumber(v, 300))}
              hint="Напр.: 300"
            />

            <Field
              label="Средняя оптовая цена (руб/кг)"
              value={String(pricePerKg)}
              onChange={(v) => setPricePerKg(parseNumber(v, 1200))}
              hint="Диапазон из условия: 800–2000"
            />

            <div style={{ border: "1px dashed #ddd", borderRadius: 10, padding: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Энергия: режим тарифа</div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <input
                  type="radio"
                  checked={energyPricingMode === "perHourContainer"}
                  onChange={() => setEnergyPricingMode("perHourContainer")}
                />
                <span>руб/час за контейнер</span>
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="radio" checked={energyPricingMode === "perKwh"} onChange={() => setEnergyPricingMode("perKwh")} />
                <span>руб/кВт⋅ч</span>
              </label>
              <div style={{ marginTop: 8, color: "#555", fontSize: 12 }}>
                В твоих данных тариф дан как «150 руб/час». Это нестандартно, поэтому режим можно переключить на «руб/кВт⋅ч».
              </div>
            </div>

            <Field
              label="Мощность (кВт)"
              value={String(powerKw)}
              onChange={(v) => setPowerKw(parseNumber(v, 14))}
              hint="Из условия: 14 кВт"
            />

            <Field
              label="Часов работы/сутки"
              value={String(hoursPerDay)}
              onChange={(v) => setHoursPerDay(parseNumber(v, 18))}
              hint="Из условия: 18"
            />

            {energyPricingMode === "perHourContainer" ? (
              <Field
                label="Тариф энергии (руб/час контейнер)"
                value={String(energyRubPerHourContainer)}
                onChange={(v) => setEnergyRubPerHourContainer(parseNumber(v, 150))}
                hint="Из условия: 150 руб/час"
              />
            ) : (
              <Field
                label="Тариф энергии (руб/кВт⋅ч)"
                value={String(energyRubPerKwh)}
                onChange={(v) => setEnergyRubPerKwh(parseNumber(v, 8))}
                hint="Пример: 8"
              />
            )}

            <Field
              label="Сотрудников (шт.)"
              value={String(workers)}
              onChange={(v) => setWorkers(parseNumber(v, 1))}
              hint="Напр.: 1"
            />

            <Field
              label="Зарплата 1 сотрудника (руб/мес)"
              value={String(salaryRubPerMonth)}
              onChange={(v) => setSalaryRubPerMonth(parseNumber(v, 120000))}
              hint="Ты спросил «зп работника ?» — поставил дефолт 120k, меняй под реальность"
            />

            <Field
              label="Начисления на ФОТ (%)"
              value={String(payrollTaxesPct)}
              onChange={(v) => setPayrollTaxesPct(parseNumber(v, 30))}
              hint="Упрощённо"
            />

            <Field
              label="Семена/питание/расходники (руб/кг)"
              value={String(seedsAndConsumablesRubPerKg)}
              onChange={(v) => setSeedsAndConsumablesRubPerKg(parseNumber(v, 80))}
              hint="Зависит от культуры/технологии"
            />

            <Field
              label="Упаковка (руб/кг)"
              value={String(packagingRubPerKg)}
              onChange={(v) => setPackagingRubPerKg(parseNumber(v, 40))}
              hint="Корректируй под канал продаж"
            />

            <Field
              label="Логистика (руб/мес)"
              value={String(logisticsRubPerMonth)}
              onChange={(v) => setLogisticsRubPerMonth(parseNumber(v, 30000))}
              hint="Доставка/холод/экспедирование"
            />

            <Field
              label="Аренда/прочее (руб/мес)"
              value={String(rentAndOtherRubPerMonth)}
              onChange={(v) => setRentAndOtherRubPerMonth(parseNumber(v, 20000))}
              hint="Помещение/вода/связь и т.п."
            />

            <Field
              label="Обслуживание (руб/мес)"
              value={String(maintenanceRubPerMonth)}
              onChange={(v) => setMaintenanceRubPerMonth(parseNumber(v, 15000))}
              hint="Фильтры/ремонт/калибровки"
            />
          </div>

          <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #eee" }} />

          <h3 style={{ margin: "0 0 10px 0" }}>CAPEX (инвестиции)</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field
              label="Контейнер-ферма CAPEX (руб)"
              value={String(containerCapexRub)}
              onChange={(v) => setContainerCapexRub(parseNumber(v, 6500000))}
              hint="Оборудование/стеллажи/LED/климат/автоматика"
            />
            <Field
              label="Монтаж/подключение (руб)"
              value={String(installationRub)}
              onChange={(v) => setInstallationRub(parseNumber(v, 350000))}
              hint="Подключения/пуско-наладка"
            />
            <Field
              label="Оборотный капитал (руб)"
              value={String(workingCapitalRub)}
              onChange={(v) => setWorkingCapitalRub(parseNumber(v, 200000))}
              hint="Запас на старт"
            />
          </div>

          <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #eee" }} />

          <h3 style={{ margin: "0 0 10px 0" }}>NPV допущения</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field
              label="Ставка дисконтирования (% годовых)"
              value={String(discountRateAnnualPct)}
              onChange={(v) => setDiscountRateAnnualPct(parseNumber(v, 18))}
              hint="Напр.: 18"
            />
            <Field
              label="Горизонт NPV (мес)"
              value={String(monthsForNpv)}
              onChange={(v) => setMonthsForNpv(parseNumber(v, 36))}
              hint="Напр.: 36"
            />
          </div>
        </div>

        {/* Outputs */}
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Результаты</h2>

          <KpiGrid
            items={[
              { title: "Выручка / мес", value: rub(metrics.revenue), sub: `${num(yieldKgPerMonth)} кг × ${rub(pricePerKg)} / кг` },
              { title: "Энергия / мес", value: rub(metrics.energyCost), sub: energyPricingMode === "perHourContainer" ? "руб/час контейнер" : "руб/кВт⋅ч" },
              { title: "ФОТ+начисления / мес", value: rub(metrics.payrollTotal), sub: `${workers} чел.` },
              { title: "Расходники / мес", value: rub(metrics.consumables), sub: `${rub(seedsAndConsumablesRubPerKg)} / кг` },
              { title: "Упаковка / мес", value: rub(metrics.packaging), sub: `${rub(packagingRubPerKg)} / кг` },
              { title: "Прочий OPEX / мес", value: rub(metrics.otherOpex), sub: "логистика + аренда + обслуживание" },
              { title: "Итого OPEX / мес", value: rub(metrics.totalOpex), sub: "" },
              { title: "Операц. прибыль / мес", value: rub(metrics.operatingProfit), sub: `Маржа: ${num(metrics.marginPct)}%` },
              { title: "Себестоимость 1 кг", value: rub(metrics.costPerKg), sub: "" },
              { title: "Прибыль 1 кг", value: rub(metrics.profitPerKg), sub: "" },
              { title: "CAPEX всего", value: rub(metrics.capexTotal), sub: "контейнер + монтаж + оборотка" },
              {
                title: "Окупаемость",
                value: metrics.paybackMonths === null ? "не окупается" : `${num(metrics.paybackMonths)} мес`,
                sub: "CAPEX / прибыль в мес",
              },
              {
                title: "ROI годовой",
                value: metrics.roiAnnual === null ? "—" : `${num(metrics.roiAnnual * 100)}%`,
                sub: "прибыль год / CAPEX",
              },
              { title: "NPV", value: rub(metrics.npv), sub: `${monthsForNpv} мес, ${num(discountRateAnnualPct)}% годовых` },
            ]}
          />

          <h3 style={{ marginTop: 18 }}>Помесячно (12 месяцев)</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  {["Месяц", "Выручка", "OPEX", "Прибыль", "Кумулятив", "Кумулятив - CAPEX"].map((h) => (
                    <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: "8px 6px" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {timeline.map((r) => (
                  <tr key={r.month}>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid #f3f3f3" }}>{r.month}</td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid #f3f3f3" }}>{rub(r.revenue)}</td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid #f3f3f3" }}>{rub(r.opex)}</td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid #f3f3f3" }}>{rub(r.operatingProfit)}</td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid #f3f3f3" }}>{rub(r.cumulative)}</td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid #f3f3f3" }}>{rub(r.cumulativeAfterCapex)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 14, color: "#666", fontSize: 12, lineHeight: 1.35 }}>
            Примечание: это «быстрый» инвест-скрининг. Если нужно, добавим: налоговый контур (УСН/ОСНО), НДС, амортизацию,
            кредит/лизинг, сезонность, рост цены/урожайности, простои, потери, multi-container парк и чувствительность (tornado).
          </div>
        </div>
      </section>
    </main>
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
    <div>
      <div style={{ fontSize: 12, color: "#555", marginBottom: 6 }}>{props.label}</div>
      <input
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        inputMode="decimal"
        style={{
          width: "100%",
          padding: "10px 10px",
          borderRadius: 10,
          border: "1px solid #ddd",
          outline: "none",
          background: props.disabled ? "#fafafa" : "white",
        }}
      />
      {props.hint ? <div style={{ marginTop: 6, fontSize: 12, color: "#777" }}>{props.hint}</div> : null}
    </div>
  );
}

function KpiGrid(props: { items: Array<{ title: string; value: string; sub?: string }> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
      {props.items.map((x) => (
        <div key={x.title} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
          <div style={{ fontSize: 12, color: "#666" }}>{x.title}</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>{x.value}</div>
          {x.sub ? <div style={{ fontSize: 12, color: "#777", marginTop: 6 }}>{x.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
