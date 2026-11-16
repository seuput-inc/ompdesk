use std::future::Future;

pub(crate) async fn settle(
    first: impl Future<Output = Result<(), String>>,
    last: impl Future<Output = Result<(), String>>,
) -> Result<(), String> {
    let first = first.await;
    let last = last.await;
    match (first, last) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(first), Err(last)) => Err(format!("{first}; {last}")),
    }
}

#[cfg(test)]
mod tests {
    use super::settle;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn preceding_failure_waits_for_the_final_cleanup_receipt_and_preserves_both_errors() {
        let (entered, started) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let cleanup = settle(async { Err("native surface failed".into()) }, async {
            entered.send(()).unwrap();
            released.await.unwrap();
            Err("browser join failed".into())
        });
        tokio::pin!(cleanup);
        tokio::select! {
            result = &mut cleanup => panic!("cleanup returned before the final receipt: {result:?}"),
            result = started => result.unwrap(),
        }
        release.send(()).unwrap();
        assert_eq!(
            cleanup.await.unwrap_err(),
            "native surface failed; browser join failed"
        );
    }

    #[tokio::test]
    async fn a_failed_preview_still_completes_the_gateway_close() {
        let (closed, receipt) = oneshot::channel();
        let result = settle(async { Err("preview close failed".into()) }, async {
            closed.send(()).unwrap();
            Ok(())
        })
        .await;
        assert_eq!(receipt.await, Ok(()));
        assert_eq!(result.unwrap_err(), "preview close failed");
    }
}
