"""End-to-end check against the local preview server.
python3 tests/e2e.py OUTDIR   (server must be running fresh on :5173)"""
import sys, json, asyncio, pathlib
from playwright.async_api import async_playwright

OUT = sys.argv[1]
BASE = "http://localhost:5173"
ROOT = pathlib.Path(__file__).resolve().parent.parent
ADMIN = json.loads((ROOT / "dev/dev-users.json").read_text())[0]

# every visible text of the original form (from the reference screenshot), verbatim
ORIGINAL = [
    "اسم الشخص المدعو", "أدخل الاسم الكريم", "اختر اليوم المناسب", "يوم", "متاح للحجز",
    "وقت الحضور المفضل (من", "ص حتى", "إجمالي عدد الأشخاص (الضيف والمرافقين)",
    "تأكيد حجز الدعوة",
    "صباحك بين النخيل في كايف المزرعة", "نتشرف بحضوركم لتجربة فطور كايف الخاصة",
    "تجربة استثنائية وسط أجواء المزرعة الهادئة والمذاق الرفيع. يرجى تأكيد حجزكم لتوفير تجربة تليق بكم.",
]
errors, results = [], []
def ok(cond, msg):
    results.append(("PASS" if cond else "FAIL") + "  " + msg)

async def book(pg, name, day_idx, slot_idx, people):
    await pg.fill("#guest", name)
    await pg.click('[data-dd="day"] .dd__trigger'); await pg.wait_for_timeout(350)
    await pg.locator(f'.cal__day[data-date="{['2026-11-11','2026-11-12','2026-11-13'][day_idx]}"]').click(); await pg.wait_for_timeout(200)
    await pg.click('[data-dd="time"] .dd__trigger'); await pg.wait_for_timeout(350)
    await pg.locator('[data-dd="time"] .dd__opt').nth(slot_idx).click(); await pg.wait_for_timeout(200)
    await pg.click('[data-dd="people"] .dd__trigger'); await pg.wait_for_timeout(350)
    await pg.locator('[data-dd="people"] .dd__opt').nth(people - 1).click(); await pg.wait_for_timeout(200)
    await pg.click("[data-cta]")
    await pg.wait_for_selector("dialog[data-ticket][open]", timeout=5000)

def watch(pg, tag):
    pg.on("console", lambda m: m.type in ("error", "warning") and errors.append(f"[{tag}] {m.type}: {m.text}"))
    pg.on("pageerror", lambda e: errors.append(f"[{tag}] pageerror: {e}"))

async def run():
    async with async_playwright() as p:
        br = await p.chromium.launch()

        # ---------------- desktop visitor A ----------------
        A = await br.new_context(viewport={"width": 1440, "height": 900}, locale="ar-SA")
        a = await A.new_page(); watch(a, "visitor-A")
        await a.goto(BASE + "/", wait_until="networkidle"); await a.wait_for_timeout(2500)

        body = await a.evaluate("document.body.innerText + ' ' + [...document.querySelectorAll('input[placeholder]')].map(i=>i.placeholder).join(' ')")
        await a.click('[data-dd="day"] .dd__trigger'); await a.wait_for_timeout(400)
        body += await a.evaluate("document.querySelector('[data-dd=day] .cal').innerText")
        await a.locator('.cal__day[data-date="2026-11-11"]').click(); await a.wait_for_timeout(300)
        body += await a.evaluate("document.querySelector('[data-dd=day] .dd__value').innerText")
        await a.evaluate("document.querySelector('[data-dd=\"day\"]').scrollIntoView({block:'start'})"); await a.wait_for_timeout(500)
        await a.screenshot(path=f"{OUT}/desktop-5-day-dropdown.png")
        await a.click('[data-dd="people"] .dd__trigger'); await a.wait_for_timeout(400)
        body += await a.evaluate("document.querySelector('[data-dd=people] .dd__list').innerText")
        await a.keyboard.press("Escape")
        ORIGINAL.extend(["شخص واحد", "شخصين", "3 أشخاص", "4 أشخاص", "9 أشخاص", "يمكن اختيار من 1 إلى 9 أشخاص كحد أقصى لكل دعوة."])
        body = " ".join(body.split())
        for t in ORIGINAL: ok(t in body, f"original text present: {t}")
        ok("(من 6:00 ص حتى 9:00 ص)" in body, "time label shows requested 6–9 window")
        en = await a.evaluate("[...document.querySelectorAll('.cal__day')].filter(b=>!b.hasAttribute('aria-disabled')).map(b=>b.dataset.date)")
        ok(en == ['2026-11-11','2026-11-12','2026-11-13'], f"date box: only Wed/Thu/Fri can be chosen ({en})")

        # empty submit → no booking, fields flagged
        await a.click("[data-cta]"); await a.wait_for_timeout(500)
        ok(await a.locator(".step.is-invalid").count() == 3, "submit with only the day chosen flags the other three steps")

        # first booking (4 on Wednesday)
        await book(a, "ضيف أول", 0, 0, 4)
        await a.wait_for_timeout(1200)
        await a.screenshot(path=f"{OUT}/desktop-6-ticket.png")
        await a.click("[data-ticket-close]")

        # visitor B (phone) books 4 more on Wednesday
        B = await br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="ar-SA")
        b = await B.new_page(); watch(b, "visitor-B")
        await b.goto(BASE + "/", wait_until="networkidle"); await b.wait_for_timeout(2200)
        await b.evaluate("document.querySelector('.step[data-step=\"2\"]').scrollIntoView()"); await b.wait_for_timeout(800)
        await b.click('[data-dd="day"] .dd__trigger'); await b.wait_for_timeout(700)
        await b.screenshot(path=f"{OUT}/mobile-5-day-sheet.png")
        await b.locator('.cal__day[data-date="2026-11-11"]').click(); await b.wait_for_timeout(300)
        await b.fill("#guest", "ضيف ثانٍ")
        await b.click('[data-dd="time"] .dd__trigger'); await b.wait_for_timeout(600)
        await b.locator('[data-dd="time"] .dd__opt').nth(1).click(); await b.wait_for_timeout(300)
        await b.evaluate("document.querySelector('.step[data-step=\"4\"]').scrollIntoView({block:'center'})"); await b.wait_for_timeout(500)
        await b.click('[data-dd="people"] .dd__trigger'); await b.wait_for_timeout(600)
        await b.screenshot(path=f"{OUT}/mobile-6-people.png")
        await b.locator('[data-dd="people"] .dd__opt').nth(3).click(); await b.wait_for_timeout(300)
        await b.click("[data-cta]")
        await b.wait_for_selector("dialog[data-ticket][open]", timeout=5000); await b.wait_for_timeout(1100)
        await b.screenshot(path=f"{OUT}/mobile-7-ticket.png")
        await b.click("[data-ticket-close]")

        # A: Wednesday now has 2 seats left → options 3 and 4 are disabled
        await a.reload(wait_until="networkidle"); await a.wait_for_timeout(1500)
        if await a.locator("dialog[data-ticket][open]").count(): await a.click("[data-ticket-close]")
        await a.click('[data-dd="day"] .dd__trigger'); await a.wait_for_timeout(300)
        await a.locator('.cal__day[data-date="2026-11-11"]').click(); await a.wait_for_timeout(300)
        dis = await a.evaluate("[...document.querySelectorAll('[data-dd=people] .dd__opt')].map(o=>o.getAttribute('aria-disabled')==='true')")
        ok(dis == [False, False] + [True]*7, f"with 2 seats left, only 1 and 2 can be chosen ({dis})")
        await a.evaluate("document.querySelector('.step[data-step=\"4\"]').scrollIntoView({block:'center'})"); await a.wait_for_timeout(600)
        await a.screenshot(path=f"{OUT}/desktop-7-limited.png")
        await book(a, "ضيف ثالث", 0, 2, 2); await a.click("[data-ticket-close]")

        # B: without reloading, the poll closes Wednesday on the phone too
        await b.wait_for_timeout(11000)
        await b.click('[data-dd="day"] .dd__trigger'); await b.wait_for_timeout(600)
        wed = await b.locator('.cal__day[data-date="2026-11-11"]').get_attribute("aria-disabled")
        ok(wed == "true", "visitor B sees Wednesday closed automatically (no reload)")
        await b.screenshot(path=f"{OUT}/mobile-8-full-day.png")

        # direct API attempt on a full day is refused by the database
        r = await a.evaluate("""async () => { const av = await (await fetch('/rest/v1/rpc/get_availability',{method:'POST'})).json();
          const res = await fetch('/rest/v1/rpc/create_booking',{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({p_name:'تجاوز',p_day:'wed',p_slot:av.slots[0].id,p_party:1,p_token:crypto.randomUUID()})});
          return res.json(); }""")
        ok(r.get("error") == "day_full", f"server refuses booking on a full day ({r})")
        r2 = await a.evaluate("fetch('/rest/v1/rpc/admin_dashboard',{method:'POST'}).then(r=>r.status)")
        ok(r2 in (401, 403), f"admin data refused without login (HTTP {r2})")

        # ---------------- admin ----------------
        C = await br.new_context(viewport={"width": 1440, "height": 900}, locale="ar-SA")
        c = await C.new_page(); watch(c, "admin")
        await c.goto(BASE + "/admin.html", wait_until="networkidle"); await c.wait_for_timeout(600)
        await c.screenshot(path=f"{OUT}/admin-1-login.png")
        await c.fill('input[name=email]', ADMIN["email"]); await c.fill('input[name=password]', "wrong-password")
        await c.click('[data-login] button'); await c.wait_for_timeout(700)
        ok(await c.locator("[data-login-err]").is_visible(), "wrong password is rejected")
        await c.fill('input[name=password]', ADMIN["password"]); await c.click('[data-login] button')
        await c.wait_for_selector('[data-view="app"]:not([hidden])', timeout=5000); await c.wait_for_timeout(800)
        k = await c.evaluate("[...document.querySelectorAll('[data-k]')].map(e=>e.textContent)")
        ok(k == ["3", "10", "20"], f"KPIs bookings/guests/remaining = {k}")
        await c.screenshot(path=f"{OUT}/admin-2-dashboard.png", full_page=True)
        # cancel one → seats return; then close Thursday and add a slot
        await c.select_option('.row[data-b] select', "cancelled"); await c.wait_for_timeout(900)
        k2 = await c.evaluate("document.querySelector('[data-k=remaining]').textContent")
        ok(k2 in ("22", "24"), f"cancelling frees seats (remaining {k2})")
        await c.locator('[data-day="thu"] [data-day-open]').evaluate("el => el.click()"); await c.wait_for_timeout(900)
        await c.click("[data-add-slot]"); await c.wait_for_timeout(900)
        ok(await c.locator("[data-slot]").count() == 4, "admin added a time slot")
        await a.reload(wait_until="networkidle"); await a.wait_for_timeout(1200)
        if await a.locator("dialog[data-ticket][open]").count(): await a.click("[data-ticket-close]")
        await a.click('[data-dd="day"] .dd__trigger'); await a.wait_for_timeout(300)
        thu = await a.locator('.cal__day[data-date="2026-11-12"]').get_attribute("aria-disabled")
        ok(thu == "true", "Thursday closed by admin is closed for visitors")
        await a.keyboard.press("Escape")
        await a.click('[data-dd="time"] .dd__trigger'); await a.wait_for_timeout(300)
        ok(await a.locator('[data-dd="time"] .dd__opt').count() == 4, "new slot appears for visitors")
        lbl = await a.evaluate("document.querySelector('[data-time-label]').textContent")
        ok(lbl == "وقت الحضور المفضل (من 6:00 ص حتى 10:00 ص)", f"time label follows the slots: {lbl}")
        # admin on phone
        D = await br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="ar-SA")
        d = await D.new_page(); watch(d, "admin-mobile")
        await d.goto(BASE + "/admin.html", wait_until="networkidle")
        await d.fill('input[name=email]', ADMIN["email"]); await d.fill('input[name=password]', ADMIN["password"]); await d.click('[data-login] button')
        await d.wait_for_selector('[data-view="app"]:not([hidden])', timeout=5000); await d.wait_for_timeout(800)
        await d.screenshot(path=f"{OUT}/admin-3-mobile.png", full_page=True)
        await br.close()

    print("\n".join(results))
    print("\nconsole:", "\n".join(errors) or "no errors or warnings")
    print(f"\n{sum(r.startswith('PASS') for r in results)}/{len(results)} passed")

asyncio.run(run())
