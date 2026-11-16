import { describe, expect, it } from "vitest";
import { resolveSpokenName, spokenShopName } from "@/lib/ai-dialer/spokenName";

// Real listing titles from dealer_leads (sandbox, 13 Nov 2026).
describe("spokenShopName", () => {
    it.each([
        // Brand banner in front of the dealer's own name.
        ["Eastman Dealer - Yadav Auto Battery", "Yadav Auto Battery"],
        ["TVS - Dynamic Motors Pvt Ltd", "Dynamic Motors"],
        ["Exide Care - Jay Batteries", "Jay Batteries"],
        ["Livguard - Shree Raksha Distributor", "Shree Raksha"],
        ["Montra Electric - Rbvs Vidhyuth Mobility, Mysuru", "Rbvs Vidhyuth Mobility"],
        ["Amaron Pitstop - Battery Arcade", "Battery Arcade"],
        ["Honda: Ujjain Honda(Agar Road)", "Ujjain Honda"],
        // …but a city after the brand is not a name.
        ["Chetak EV Scooter - Mysore", "Chetak EV Scooter"],
        // Search-engine tails.
        ["Bansal Battery House - exide Car Battery | Amaron Car Battery Dealer Saket", "Bansal Battery House"],
        ["City battery house best Exide Amaron car & inverter battery dealer near me", "City Battery House"],
        ["GN Battery-Exide Battery Dealers Near Me | Amaron Inverter Battery", "GN Battery"],
        ["Sachdeva Traders - Battery Shop In Malviya Nagar - Car Battery In Malviya Nagar", "Sachdeva Traders"],
        ["SRA ELECTRIC PRIVATE LIMITED Solar Company Luminous Solar, Waaree Solar", "SRA Electric"],
        ["Battery Wala (P) Ltd / Best Inverter Battery Dealer/ Lithium/Wholesale", "Battery Wala"],
        // Legal and generic suffixes — generic only when two words are left.
        ["Volta Lithium Hub Private Limited", "Volta Lithium Hub"],
        ["Shri Rudranand Enterprises (Luminous Distributor)", "Shri Rudranand"],
        ["Bhawani Singh And Sons", "Bhawani Singh"],
        ["Ajit Enterprises", "Ajit Enterprises"],
        ["T N G ENTERPRISES", "TNG Enterprises"],
        // Initials, capitals, dangling joiners, three words at most.
        ["K.G.N SCRAP TRADERS", "KGN Scrap"],
        ["M. S. AUTOTECH", "MS Autotech"],
        ["J.M.D E-Vehicles HUB", "JMD E-Vehicles HUB"],
        ["NEW GAURI MOTORS(BANDA)", "New Gauri Motors"],
        ["Shyam battery and tyre", "Shyam Battery"],
        ["Auto Electrical & Battery Works", "Auto Electrical"],
        ["OM TVS Service Center Masoodpur Vasant Kunj", "Om TVS Service"],
        ["A-ONE - Best Car & Inverter Battery Shop in Gurgaon", "A-one"],
        ["Ather", "Ather"],
        // One shop per line in a pasted title: the first line.
        ["Chhotu Battery\nChaddha Motors \nParry Battery Mart", "Chhotu Battery"],
    ])("%s → %s", (raw, spoken) => {
        expect(spokenShopName(raw)).toBe(spoken);
    });

    it("is empty for no name", () => {
        expect(spokenShopName(null)).toBe("");
        expect(spokenShopName("   ")).toBe("");
    });

    it("never returns more than three words", () => {
        expect(spokenShopName("Kubereshwar Mahadev E-Rikshaw Vehicle Automobiles").split(" ").length).toBeLessThanOrEqual(3);
    });
});

describe("resolveSpokenName", () => {
    it("a rep's override wins, a blank one does not", () => {
        expect(resolveSpokenName("TVS - Dynamic Motors Pvt Ltd", "Dynamic Motors Kanpur")).toBe("Dynamic Motors Kanpur");
        expect(resolveSpokenName("TVS - Dynamic Motors Pvt Ltd", "  ")).toBe("Dynamic Motors");
    });
});
