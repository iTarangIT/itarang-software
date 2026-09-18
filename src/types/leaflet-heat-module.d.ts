/**
 * Module-scoped twin of leaflet-heat.d.ts. LocationMap holds the *imported*
 * leaflet module (`(await import('leaflet')).default`), which the global
 * `declare namespace L` next door does not reach — so the module itself is
 * augmented with the one factory leaflet.heat adds.
 */
import type { Layer } from "leaflet";

declare module "leaflet" {
    interface HeatLayerOptions {
        radius?: number;
        blur?: number;
        max?: number;
        maxZoom?: number;
        minOpacity?: number;
        gradient?: Record<number, string>;
    }

    interface HeatLayer extends Layer {
        setLatLngs(latlngs: Array<[number, number, number]>): this;
        setOptions(options: HeatLayerOptions): this;
        redraw(): this;
    }

    function heatLayer(
        latlngs: Array<[number, number, number]>,
        options?: HeatLayerOptions,
    ): HeatLayer;
}
