import { describe, expect, it } from "vitest";
import { looksTurkish } from "./epubTypography";

const turkish =
  "Bazı şeylerin yitmesini, kararmasını ve değişmesini görmek özel bir zevk veriyordu. " +
  "Avuçlarında, dev piton yılanını andıran bakır çinko alaşımı hortumla dünyaya zehirli " +
  "gazyağı püskürtürken, kanının beyninde zonkladığını hissediyordu. Elleri, tarihin " +
  "paçavralarını ve kömürleşmiş kalıntılarını yok etmek için ateş ve alevin tüm senfonilerini " +
  "aleşlendiren olağanüstü bir orkestra şefinin elleriydi. Sembolik miğferi kafasında, " +
  "kasvetli düşüncelerle dolu gözleri ışıl ışıl parlıyordu.";
const english =
  "It was a pleasure to burn. It was a special pleasure to see things eaten, to see things " +
  "blackened and changed. With the brass nozzle in his fists, with this great python spitting " +
  "its venomous kerosene upon the world, the blood pounded in his head, and his hands were the " +
  "hands of some amazing conductor playing all the symphonies of blazing and burning to bring " +
  "down the tatters and charcoal ruins of history. With his symbolic helmet numbered 451 on his " +
  "stolid head, and his eyes all orange flame with the thought of what came next.";

describe("looksTurkish", () => {
  it("recognises Turkish prose whatever the package declares", () => {
    expect(looksTurkish(turkish)).toBe(true);
  });

  it("leaves English prose alone", () => {
    expect(looksTurkish(english)).toBe(false);
  });

  it("does not decide from a few words", () => {
    expect(looksTurkish("Yakmak bir zevkti. Işığı söndür.")).toBe(false);
  });
});
