/** A2UI's content components on the kit: Text (sanitized Markdown), Image (the reply pictures' rule), Icon (lucide). */

import {
	ArrowLeft,
	ArrowRight,
	Bell,
	BellOff,
	Calendar,
	CalendarDays,
	Camera,
	Check,
	CircleAlert,
	CircleHelp,
	CircleUserRound,
	CreditCard,
	Download,
	Ellipsis,
	EllipsisVertical,
	Eye,
	EyeOff,
	FastForward,
	Folder,
	Heart,
	HeartOff,
	House,
	Image as ImageIcon,
	Info,
	Lock,
	LockOpen,
	type LucideIcon,
	Mail,
	MapPin,
	Menu,
	Paperclip,
	Pause,
	Pencil,
	Phone,
	Play,
	Plus,
	Printer,
	RefreshCw,
	Rewind,
	Search,
	Send,
	Settings,
	Share2,
	ShoppingCart,
	SkipBack,
	SkipForward,
	Smartphone,
	Square,
	Star,
	StarHalf,
	StarOff,
	Trash2,
	TriangleAlert,
	Upload,
	User,
	Volume,
	Volume1,
	Volume2,
	VolumeX,
	X,
} from "lucide-react";
import { cx } from "../../format";
import { MarkdownImage, MarkdownRenderer } from "../../markdown";
import { read, readText, type ViewProps } from "./props";

/** The catalog's icon names (a2ui-catalog.json `Icon.name`); anything else, an `svgPath` included, draws nothing. */
const ICONS: Record<string, LucideIcon> = {
	accountCircle: CircleUserRound,
	add: Plus,
	arrowBack: ArrowLeft,
	arrowForward: ArrowRight,
	attachFile: Paperclip,
	calendarToday: CalendarDays,
	call: Phone,
	camera: Camera,
	check: Check,
	close: X,
	delete: Trash2,
	download: Download,
	edit: Pencil,
	event: Calendar,
	error: CircleAlert,
	fastForward: FastForward,
	favorite: Heart,
	favoriteOff: HeartOff,
	folder: Folder,
	help: CircleHelp,
	home: House,
	info: Info,
	locationOn: MapPin,
	lock: Lock,
	lockOpen: LockOpen,
	mail: Mail,
	menu: Menu,
	moreVert: EllipsisVertical,
	moreHoriz: Ellipsis,
	notificationsOff: BellOff,
	notifications: Bell,
	pause: Pause,
	payment: CreditCard,
	person: User,
	phone: Smartphone,
	photo: ImageIcon,
	play: Play,
	print: Printer,
	refresh: RefreshCw,
	rewind: Rewind,
	search: Search,
	send: Send,
	settings: Settings,
	share: Share2,
	shoppingCart: ShoppingCart,
	skipNext: SkipForward,
	skipPrevious: SkipBack,
	star: Star,
	starHalf: StarHalf,
	starOff: StarOff,
	stop: Square,
	upload: Upload,
	visibility: Eye,
	visibilityOff: EyeOff,
	volumeDown: Volume1,
	volumeMute: Volume,
	volumeOff: VolumeX,
	volumeUp: Volume2,
	warning: TriangleAlert,
};

/** In a button or a dialog trigger a Text is the label's words, not a Markdown block. */
export function TextView({ props, inline }: ViewProps & { inline?: boolean }) {
	const text = readText(props.text);
	if (inline) return <>{text}</>;
	return (
		<div className={cx("min-w-0", props.variant === "caption" && "text-sc-sm text-(--sc-text-muted)")}>
			<MarkdownRenderer content={text} />
		</div>
	);
}

export function ImageView({ props }: ViewProps) {
	const url = read(props.url);
	return <MarkdownImage alt={readText(props.description)} src={typeof url === "string" ? url : undefined} />;
}

export function IconView({ props }: ViewProps) {
	const Icon = typeof props.name === "string" ? ICONS[props.name] : undefined;
	return Icon ? <Icon aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-secondary)" /> : null;
}
