
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface PDIFormProps {
    data: {
        oem_inventory_id: string;
        provision_id: string;
        serial_number: string | null;
        product_model: string;
        asset_type: string;
        oem_name: string;
    };
    engineerId: string; // Passed from server (should be auth user id)
}

export default function PDIForm({ data, engineerId }: PDIFormProps) {
    const router = useRouter();
    const [submitting, setSubmitting] = useState(false);
    const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
    const [locationError, setLocationError] = useState<string | null>(null);
    const [uploadingFiles, setUploadingFiles] = useState<{ [key: string]: boolean }>({
        product_manual: false,
        warranty_doc: false,
        pdi_photos: false
    });
    const [uploadErrors, setUploadErrors] = useState<{ [key: string]: string | null }>({
        product_manual: null,
        warranty_doc: null,
        pdi_photos: null
    });

    const [formData, setFormData] = useState({
        physical_condition: '',
        discharging_connector: 'ok',
        charging_connector: 'ok',
        productor_sticker: 'ok',
        voltage: '',
        soc: '',
        pdi_status: 'pass', // pass, fail
        failure_reason: '',
        // New Fields
        capacity_ah: '',
        resistance_mohm: '',
        temperature_celsius: '',
        iot_imei_no: '',
        // Files
        product_manual_url: '',
        warranty_document_url: '',
        pdi_photos: [] as string[],
    });

    const handleFileUpload = async (file: File, bucket: string): Promise<string> => {
        try {
            // Create Supabase client
            const { createClient } = await import('@/lib/supabase/client');
            const supabase = createClient();

            // Generate unique filename
            const timestamp = Date.now();
            const randomString = Math.random().toString(36).substring(2, 15);
            const fileExt = file.name.split('.').pop();
            const fileName = `${timestamp}_${randomString}.${fileExt}`;
            const filePath = `${bucket}/${fileName}`;

            // Upload file to Supabase Storage
            const { data, error } = await supabase.storage
                .from(bucket)
                .upload(filePath, file, {
                    cacheControl: '3600',
                    upsert: false
                });

            if (error) {
                console.error('Upload error:', error);
                throw new Error(`Failed to upload ${file.name}: ${error.message}`);
            }

            // Get public URL
            const { data: { publicUrl } } = supabase.storage
                .from(bucket)
                .getPublicUrl(filePath);

            return publicUrl;
        } catch (error: any) {
            console.error('File upload failed:', error);
            throw error;
        }
    };

    const handleLocationCapture = () => {
        if (!navigator.geolocation) {
            setLocationError('Geolocation is not supported by your browser');
            return;
        }

        setLocationError(null);
        navigator.geolocation.getCurrentPosition(
            (position) => {
                setLocation({
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                });
            },
            (error) => {
                setLocationError('Unable to retrieve your location');
                console.error(error);
            }
        );
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!location) {
            alert('GPS Location is mandatory!');
            return;
        }

        setSubmitting(true);

        try {
            const payload = {
                oem_inventory_id: data.oem_inventory_id,
                provision_id: data.provision_id,
                service_engineer_id: engineerId,
                latitude: location.lat,
                longitude: location.lng,
                physical_condition: formData.physical_condition,
                discharging_connector: formData.discharging_connector,
                charging_connector: formData.charging_connector,
                productor_sticker: formData.productor_sticker,
                voltage: parseFloat(formData.voltage) || 0,
                soc: parseInt(formData.soc) || 0,
                pdi_status: formData.pdi_status,
                failure_reason: formData.pdi_status === 'fail' ? formData.failure_reason : null,
                // New Fields
                capacity_ah: parseFloat(formData.capacity_ah) || 0,
                resistance_mohm: parseFloat(formData.resistance_mohm) || 0,
                temperature_celsius: parseFloat(formData.temperature_celsius) || 0,
                iot_imei_no: formData.iot_imei_no,
                product_manual_url: formData.product_manual_url,
                warranty_document_url: formData.warranty_document_url,
                pdi_photos: formData.pdi_photos,
            };

            const res = await fetch('/api/pdi/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                const error = await res.json();
                throw new Error(error.error || 'Failed to submit');
            }

            // Success
            router.push('/dashboard/service-engineer');
            router.refresh();

        } catch (error: any) {
            alert(error.message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-8">
            {/* Asset Info Card */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Asset Details</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                        <span className="block text-gray-500">Product</span>
                        <span className="font-medium text-gray-900">{data.product_model}</span>
                    </div>
                    <div>
                        <span className="block text-gray-500">Serial Number</span>
                        <span className="font-medium text-gray-900">{data.serial_number || 'N/A'}</span>
                    </div>
                    <div>
                        <span className="block text-gray-500">Type</span>
                        <span className="font-medium text-gray-900">{data.asset_type}</span>
                    </div>
                    <div>
                        <span className="block text-gray-500">OEM</span>
                        <span className="font-medium text-gray-900">{data.oem_name}</span>
                    </div>
                </div>
            </div>

            {/* Inspection Form */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 space-y-6">
                <h3 className="text-lg font-semibold text-gray-900">Inspection Checklist</h3>

                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Physical Condition</label>
                    <textarea
                        required
                        className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                        rows={3}
                        placeholder="Describe any scratches, dents, or verify clean condition..."
                        value={formData.physical_condition}
                        onChange={e => setFormData({ ...formData, physical_condition: e.target.value })}
                    />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">IoT IMEI Number</label>
                        <input
                            type="text" required
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.iot_imei_no}
                            onChange={e => setFormData({ ...formData, iot_imei_no: e.target.value })}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Temperature (°C)</label>
                        <input
                            type="number" step="0.1" required
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.temperature_celsius}
                            onChange={e => setFormData({ ...formData, temperature_celsius: e.target.value })}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">IoT IMEI Number</label>
                        <input
                            type="text" required
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.iot_imei_no}
                            onChange={e => setFormData({ ...formData, iot_imei_no: e.target.value })}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Temperature (°C)</label>
                        <input
                            type="number" step="0.1" required
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.temperature_celsius}
                            onChange={e => setFormData({ ...formData, temperature_celsius: e.target.value })}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Voltage (V)</label>
                        <input
                            type="number" step="0.01" required
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.voltage}
                            onChange={e => setFormData({ ...formData, voltage: e.target.value })}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">SOC (%)</label>
                        <input
                            type="number" required
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.soc}
                            onChange={e => setFormData({ ...formData, soc: e.target.value })}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Capacity (Ah)</label>
                        <input
                            type="number" step="0.1" required
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.capacity_ah}
                            onChange={e => setFormData({ ...formData, capacity_ah: e.target.value })}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Resistance (mΩ)</label>
                        <input
                            type="number" step="0.01" required
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.resistance_mohm}
                            onChange={e => setFormData({ ...formData, resistance_mohm: e.target.value })}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Discharging Connector</label>
                        <select
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.discharging_connector}
                            onChange={e => setFormData({ ...formData, discharging_connector: e.target.value })}
                        >
                            <option value="ok">OK</option>
                            <option value="damaged">Damaged</option>
                            <option value="missing">Missing</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Charging Connector</label>
                        <select
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.charging_connector}
                            onChange={e => setFormData({ ...formData, charging_connector: e.target.value })}
                        >
                            <option value="ok">OK</option>
                            <option value="damaged">Damaged</option>
                            <option value="missing">Missing</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Product Sticker</label>
                        <select
                            className="w-full rounded-xl border-gray-200 focus:border-brand-500 focus:ring-brand-500"
                            value={formData.productor_sticker}
                            onChange={e => setFormData({ ...formData, productor_sticker: e.target.value })}
                        >
                            <option value="ok">OK</option>
                            <option value="damaged">Damaged</option>
                            <option value="missing">Missing</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* Document Uploads */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Documents & Evidence</h3>

                <div className="space-y-6">
                    {/* Product Manual */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Product Manual <span className="text-red-500">*</span>
                        </label>
                        <input
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png"
                            disabled={uploadingFiles.product_manual}
                            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100 disabled:opacity-50"
                            onChange={async (e) => {
                                if (e.target.files?.[0]) {
                                    setUploadingFiles(prev => ({ ...prev, product_manual: true }));
                                    setUploadErrors(prev => ({ ...prev, product_manual: null }));
                                    try {
                                        const url = await handleFileUpload(e.target.files[0], 'pdi-documents');
                                        setFormData({ ...formData, product_manual_url: url });
                                    } catch (error: any) {
                                        setUploadErrors(prev => ({ ...prev, product_manual: error.message }));
                                    } finally {
                                        setUploadingFiles(prev => ({ ...prev, product_manual: false }));
                                    }
                                }
                            }}
                        />
                        {uploadingFiles.product_manual && (
                            <p className="text-sm text-blue-600 mt-1">⏳ Uploading...</p>
                        )}
                        {uploadErrors.product_manual && (
                            <p className="text-sm text-red-600 mt-1">❌ {uploadErrors.product_manual}</p>
                        )}
                        {formData.product_manual_url && !uploadingFiles.product_manual && (
                            <p className="text-sm text-green-600 mt-1">✓ Uploaded successfully</p>
                        )}
                    </div>

                    {/* Warranty Document */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Warranty Document <span className="text-red-500">*</span>
                        </label>
                        <input
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png"
                            disabled={uploadingFiles.warranty_doc}
                            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100 disabled:opacity-50"
                            onChange={async (e) => {
                                if (e.target.files?.[0]) {
                                    setUploadingFiles(prev => ({ ...prev, warranty_doc: true }));
                                    setUploadErrors(prev => ({ ...prev, warranty_doc: null }));
                                    try {
                                        const url = await handleFileUpload(e.target.files[0], 'pdi-documents');
                                        setFormData({ ...formData, warranty_document_url: url });
                                    } catch (error: any) {
                                        setUploadErrors(prev => ({ ...prev, warranty_doc: error.message }));
                                    } finally {
                                        setUploadingFiles(prev => ({ ...prev, warranty_doc: false }));
                                    }
                                }
                            }}
                        />
                        {uploadingFiles.warranty_doc && (
                            <p className="text-sm text-blue-600 mt-1">⏳ Uploading...</p>
                        )}
                        {uploadErrors.warranty_doc && (
                            <p className="text-sm text-red-600 mt-1">❌ {uploadErrors.warranty_doc}</p>
                        )}
                        {formData.warranty_document_url && !uploadingFiles.warranty_doc && (
                            <p className="text-sm text-green-600 mt-1">✓ Uploaded successfully</p>
                        )}
                    </div>

                    {/* PDI Photos */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            PDI Photos (Multiple allowed)
                        </label>
                        <input
                            type="file"
                            accept=".jpg,.jpeg,.png"
                            multiple
                            disabled={uploadingFiles.pdi_photos}
                            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100 disabled:opacity-50"
                            onChange={async (e) => {
                                if (e.target.files && e.target.files.length > 0) {
                                    setUploadingFiles(prev => ({ ...prev, pdi_photos: true }));
                                    setUploadErrors(prev => ({ ...prev, pdi_photos: null }));
                                    try {
                                        const urls = [];
                                        for (let i = 0; i < e.target.files.length; i++) {
                                            const url = await handleFileUpload(e.target.files[i], 'pdi-photos');
                                            urls.push(url);
                                        }
                                        setFormData({ ...formData, pdi_photos: urls });
                                    } catch (error: any) {
                                        setUploadErrors(prev => ({ ...prev, pdi_photos: error.message }));
                                    } finally {
                                        setUploadingFiles(prev => ({ ...prev, pdi_photos: false }));
                                    }
                                }
                            }}
                        />
                        {uploadingFiles.pdi_photos && (
                            <p className="text-sm text-blue-600 mt-1">⏳ Uploading photos...</p>
                        )}
                        {uploadErrors.pdi_photos && (
                            <p className="text-sm text-red-600 mt-1">❌ {uploadErrors.pdi_photos}</p>
                        )}
                        {formData.pdi_photos.length > 0 && !uploadingFiles.pdi_photos && (
                            <p className="text-sm text-green-600 mt-1">✓ {formData.pdi_photos.length} photo(s) uploaded</p>
                        )}
                    </div>
                </div>
            </div>

            {/* GPS Location */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Location Validation</h3>

                <div className="flex items-center gap-4">
                    <button
                        type="button"
                        onClick={handleLocationCapture}
                        className={`px-4 py-2 rounded-lg font-medium transition-colors ${location
                            ? 'bg-green-50 text-green-700 border border-green-200'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200'
                            }`}
                    >
                        {location ? '✓ Location Captured' : '📍 Capture GPS Location'}
                    </button>
                    {location && (
                        <span className="text-xs text-mono text-gray-500">
                            {location.lat.toFixed(6)}, {location.lng.toFixed(6)}
                        </span>
                    )}
                </div>
                {locationError && (
                    <p className="text-red-500 text-sm mt-2">{locationError}</p>
                )}
            </div>

            {/* Decision */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Final Decision</h3>

                <div className="flex gap-4 mb-4">
                    <label className={`flex-1 cursor-pointer p-4 rounded-xl border-2 transition-all ${formData.pdi_status === 'pass'
                        ? 'border-brand-500 bg-brand-50 text-brand-700'
                        : 'border-gray-100 hover:border-gray-200'
                        }`}>
                        <input
                            type="radio" name="status" value="pass" className="sr-only"
                            checked={formData.pdi_status === 'pass'}
                            onChange={() => setFormData({ ...formData, pdi_status: 'pass' })}
                        />
                        <div className="text-center font-bold">PASS</div>
                    </label>

                    <label className={`flex-1 cursor-pointer p-4 rounded-xl border-2 transition-all ${formData.pdi_status === 'fail'
                        ? 'border-red-500 bg-red-50 text-red-700'
                        : 'border-gray-100 hover:border-gray-200'
                        }`}>
                        <input
                            type="radio" name="status" value="fail" className="sr-only"
                            checked={formData.pdi_status === 'fail'}
                            onChange={() => setFormData({ ...formData, pdi_status: 'fail' })}
                        />
                        <div className="text-center font-bold">FAIL</div>
                    </label>
                </div>

                {formData.pdi_status === 'fail' && (
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Failure Reason</label>
                        <textarea
                            required
                            className="w-full rounded-xl border-red-200 focus:border-red-500 focus:ring-red-500"
                            rows={3}
                            placeholder="Explain why this unit failed inspection..."
                            value={formData.failure_reason}
                            onChange={e => setFormData({ ...formData, failure_reason: e.target.value })}
                        />
                    </div>
                )}
            </div>

            <button
                type="submit"
                disabled={submitting}
                className="w-full bg-brand-600 hover:bg-brand-700 text-white font-bold py-4 px-6 rounded-2xl shadow-lg hover:shadow-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg"
            >
                {submitting ? 'Submitting...' : 'Submit Inspection Record'}
            </button>
        </form>
    );
}
