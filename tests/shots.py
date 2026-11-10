"""Screenshots + console check. python3 tests/shots.py OUTDIR [base]"""
import sys, asyncio
from playwright.async_api import async_playwright

OUT = sys.argv[1]
BASE = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5173"

async def run():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        errors = []
        for name, vp, mobile in [("desktop", {"width": 1440, "height": 900}, False), ("mobile", {"width": 390, "height": 844}, True)]:
            ctx = await b.new_context(viewport=vp, device_scale_factor=1 if not mobile else 2, is_mobile=mobile, has_touch=mobile, locale="ar-SA")
            pg = await ctx.new_page()
            pg.on("console", lambda m, n=name: m.type in ("error", "warning") and errors.append(f"[{n}] {m.type}: {m.text}"))
            pg.on("pageerror", lambda e, n=name: errors.append(f"[{n}] pageerror: {e}"))
            await pg.goto(BASE + "/", wait_until="networkidle")
            await pg.wait_for_timeout(3200)
            await pg.screenshot(path=f"{OUT}/{name}-1-hero.png")
            H = await pg.evaluate("innerHeight")
            await pg.mouse.wheel(0, H * 0.55); await pg.wait_for_timeout(900)
            await pg.screenshot(path=f"{OUT}/{name}-2-opening.png")
            await pg.evaluate("document.querySelector('#invite').scrollIntoView()"); await pg.wait_for_timeout(1500)
            await pg.screenshot(path=f"{OUT}/{name}-3-invite.png")
            await pg.evaluate("document.querySelector('.step[data-step=\"3\"]').scrollIntoView({block:'center'})"); await pg.wait_for_timeout(1500)
            await pg.screenshot(path=f"{OUT}/{name}-4-steps.png")
            await ctx.close()
        await b.close()
        print("\n".join(errors) or "no console errors")

asyncio.run(run())
