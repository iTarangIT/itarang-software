import vision from "@google-cloud/vision";

const client = new vision.ImageAnnotatorClient();

export async function extractTextFromImageBuffer(buffer: Buffer) {
    const [result] = await client.textDetection({ image: { content: buffer } });

    return (
        result?.fullTextAnnotation?.text ||
        result?.textAnnotations?.[0]?.description ||
        ""
    );
}
