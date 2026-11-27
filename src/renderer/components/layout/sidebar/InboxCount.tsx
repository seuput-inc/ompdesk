import { useQuestionInbox } from "../../../hooks/use-question-inbox";
import { Badge } from "../../common";

export function InboxCount() {
	const count = useQuestionInbox().length;
	return count ? <Badge size="xs">{count}</Badge> : null;
}
