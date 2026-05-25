"use client";

import { Modal } from "@/app/(dashboard)/inside-sales/_components/Modal";
import { Button } from "@/components/ui/button";
import {
    useVisitForm,
    VisitFields,
} from "@/app/(dashboard)/asm/_components/VisitFields";
import type { VisitNextAction } from "@/lib/asm/types";

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    onSuccess: (result: { next_action: VisitNextAction }) => void;
};

export function LogVisitModal({ open, onClose, leadId, onSuccess }: Props) {
    const form = useVisitForm(open);

    const handleSubmit = async () => {
        const result = await form.submit(leadId);
        if (result) onSuccess(result);
    };

    return (
        <Modal
            open={open}
            onClose={() => !form.submitting && onClose()}
            title="Log Visit"
            subtitle="ASM ground action audit row"
            width="lg"
            closeOnBackdrop={!form.submitting}
            footer={
                <>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={onClose}
                        disabled={form.submitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={handleSubmit}
                        disabled={form.submitting}
                    >
                        {form.submitting ? "Saving…" : "Save visit"}
                    </Button>
                </>
            }
        >
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    void handleSubmit();
                }}
            >
                <VisitFields form={form} />
            </form>
        </Modal>
    );
}
