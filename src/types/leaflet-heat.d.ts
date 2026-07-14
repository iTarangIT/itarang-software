/**
 * leaflet.heat ships no types. It augments the Leaflet namespace with a single factory, so
 * that is all we declare — writing the whole plugin's surface would be inventing an API we do
 * not call.
 */
declare module 'leaflet.heat';

declare namespace L {
    interface HeatLayerOptions {
        /** Point radius, in px. */
        radius?: number;
        /** How far each point's influence bleeds, in px. */
        blur?: number;
        /** Intensity ceiling — the weight at which a point is fully saturated. */
        max?: number;
        maxZoom?: number;
        minOpacity?: number;
        /** Stops keyed 0..1. */
        gradient?: Record<number, string>;
    }

    interface HeatLayer extends L.Layer {
        setLatLngs(latlngs: Array<[number, number, number]>): this;
        setOptions(options: HeatLayerOptions): this;
        redraw(): this;
    }

    function heatLayer(
        latlngs: Array<[number, number, number]>,
        options?: HeatLayerOptions,
    ): HeatLayer;
}
