const notifyWebhookProcessingError = async (matrix, error) => {
    const errorMessage = error?.message || String(error);
    console.error('Error processing webhook:', errorMessage);

    try {
        await matrix.sendMatrixNotification(`Failed to process Grafana webhook: ${errorMessage}`);
    } catch (notifyError) {
        console.error('Failed to send webhook processing error to Matrix:', notifyError?.message || String(notifyError));
    }
};

export { notifyWebhookProcessingError };
