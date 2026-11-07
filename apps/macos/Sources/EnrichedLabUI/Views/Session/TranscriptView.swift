import EnrichedLabKit
import SwiftUI
import Textual

/// The run sheet: the person's request, the agent's thinking, its steps as one activity per stretch of work, and its
/// answer, typeset for reading. It follows new output while the reader is at the bottom and stays put otherwise.
struct TranscriptView: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel
	@State private var position = ScrollPosition(edge: .bottom)
	@State private var pinned = true

	var body: some View {
		ScrollView {
			LazyVStack(alignment: .leading, spacing: 18) {
				ForEach(session.blocks) { block in
					BlockView(block: block, session: session)
				}
				if session.busy || !session.partial.text.isEmpty {
					LiveView(session: session)
				}
				if !session.busy, session.blocks.isEmpty, !session.opening {
					EmptySessionView(session: session)
				}
			}
			.frame(maxWidth: Theme.measure, alignment: .leading)
			.padding(.horizontal, 32)
			.padding(.top, 28)
			.padding(.bottom, 24)
			.frame(maxWidth: .infinity)
		}
		.scrollPosition($position)
		.defaultScrollAnchor(.bottom, for: .initialOffset)
		.onScrollGeometryChange(for: Bool.self) { geometry in
			geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height < 96
		} action: { _, atBottom in
			pinned = atBottom
		}
		.onChange(of: session.blocks.count) { follow() }
		.onChange(of: session.partial.text.count) { follow() }
		.onChange(of: session.partial.reasoning.count) { follow() }
		.onChange(of: session.pending.count) { follow() }
		.overlay(alignment: .bottomTrailing) {
			if !pinned {
				Button {
					withAnimation(.smooth) { position.scrollTo(edge: .bottom) }
				} label: {
					Label("Jump to Latest", systemImage: "arrow.down")
						.labelStyle(.iconOnly)
						.frame(width: 28, height: 28)
				}
				.buttonStyle(.plain)
				.glassEffect(.regular.interactive(), in: .circle)
				.padding(16)
				.help("Jump to latest")
				.transition(.opacity.combined(with: .scale(scale: 0.9)))
			}
		}
	}

	private func follow() {
		guard pinned else { return }
		position.scrollTo(edge: .bottom)
	}
}

/// A session with nothing in it yet: where it works, in a line.
private struct EmptySessionView: View {
	var session: SessionModel

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text("Ready in \(folderName(session.summary.cwd))").font(.title3.weight(.semibold))
			Text("\(session.place.isLocal ? "Runs on This Mac, contained to the project folder." : "Runs in the \(session.place.title) sandbox.") Ask for anything below.")
				.foregroundStyle(.secondary)
		}
		.padding(.top, 40)
	}
}

/// One block of the run sheet.
struct BlockView: View {
	@Environment(AppModel.self) private var app
	var block: Block
	var session: SessionModel

	var body: some View {
		switch block {
		case let .prompt(_, text, images):
			VStack(alignment: .leading, spacing: 6) {
				Text(text)
					.font(Theme.prompt)
					.textSelection(.enabled)
					.fixedSize(horizontal: false, vertical: true)
				if images > 0 {
					Label("\(images) image\(images == 1 ? "" : "s")", systemImage: "photo")
						.font(.caption)
						.foregroundStyle(.secondary)
				}
			}
			.padding(.top, 10)
			.contextMenu { Button("Copy Request") { copyText(text, what: "the request", app: app) } }
		case let .thinking(_, text, summary, seconds):
			if app.ui.showReasoning { ThinkingView(text: text, summary: summary, seconds: seconds) }
		case let .activity(id, steps):
			ActivityView(id: id, steps: steps, session: session, live: session.busy && isLast)
		case let .answer(_, text, error, stop):
			AnswerView(text: text, error: error, stop: stop)
		case let .notice(_, level, text):
			Label(text, systemImage: level == "error" ? "exclamationmark.octagon" : level == "warn" ? "exclamationmark.triangle" : "info.circle")
				.font(.callout)
				.foregroundStyle(level == "error" ? AnyShapeStyle(Color.red) : level == "warn" ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
				.textSelection(.enabled)
		case let .rule(_, text):
			HStack(spacing: 10) {
				Rectangle().fill(.separator).frame(height: 1)
				Text(text).font(.caption).foregroundStyle(.secondary).fixedSize()
				Rectangle().fill(.separator).frame(height: 1)
			}
			.padding(.vertical, 4)
		}
	}

	private var isLast: Bool {
		session.blocks.last(where: { if case .activity = $0 { true } else { false } })?.id == block.id
	}
}

/// The agent's thinking: folded to its time and summary; the full text a click away.
struct ThinkingView: View {
	var text: String
	var summary: String?
	var seconds: Double?
	@State private var open = false

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			Button {
				withAnimation(.smooth(duration: 0.2)) { open.toggle() }
			} label: {
				HStack(alignment: .firstTextBaseline, spacing: 6) {
					Image(systemName: "chevron.right")
						.font(.caption2.weight(.semibold))
						.rotationEffect(.degrees(open ? 90 : 0))
						.foregroundStyle(.tertiary)
					Text(seconds.map { "Thought for \(durationText($0))" } ?? "Thought").foregroundStyle(.secondary)
					if let summary, !open {
						Text(summary).foregroundStyle(.tertiary).lineLimit(1)
					}
				}
				.font(.callout)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel(open ? "Hide thinking" : "Show thinking")
			if open {
				VStack(alignment: .leading, spacing: 8) {
					if let summary { Text(summary).font(.callout.weight(.medium)).foregroundStyle(.secondary) }
					Text(text)
						.font(.callout)
						.foregroundStyle(.secondary)
						.lineSpacing(3)
						.textSelection(.enabled)
						.fixedSize(horizontal: false, vertical: true)
				}
				.padding(.leading, 16)
				.transition(.opacity)
			}
		}
	}
}

func durationText(_ seconds: Double) -> String {
	let s = Int(seconds.rounded())
	return s < 60 ? "\(max(1, s)) s" : "\(s / 60) min \(s % 60) s"
}

/// The agent's answer: Markdown typeset for reading, with code blocks you can copy.
struct AnswerView: View {
	var text: String
	var error: String?
	var stop: String

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			if !text.isEmpty {
				MarkdownText(text: text)
			}
			if stop == "error" {
				Label(error ?? "The model stopped with an error.", systemImage: "exclamationmark.octagon")
					.font(.callout)
					.foregroundStyle(.red)
					.textSelection(.enabled)
			} else if stop == "cancelled" {
				Text("Stopped.").font(.callout).foregroundStyle(.secondary)
			} else if stop == "length" {
				Text("The answer reached the model's length limit.").font(.callout).foregroundStyle(.secondary)
			}
		}
	}
}

/// Markdown in the run sheet's type: GitHub-like blocks at the reading size, code blocks with a language and Copy.
struct MarkdownText: View {
	var text: String

	var body: some View {
		StructuredText(markdown: text)
			.font(Theme.prose)
			.textual.codeBlockStyle(RunSheetCodeBlock())
			.textual.structuredTextStyle(.gitHub)
			.textual.textSelection(.enabled)
			.fixedSize(horizontal: false, vertical: true)
	}
}

/// A code block: a quiet frame with the language and a Copy button.
struct RunSheetCodeBlock: StructuredText.CodeBlockStyle {
	func makeBody(configuration: Configuration) -> some View {
		CodeBlockFrame(configuration: configuration)
	}
}

private struct CodeBlockFrame: View {
	var configuration: StructuredText.CodeBlockStyleConfiguration
	@State private var copied = false

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack {
				Text(configuration.languageHint?.lowercased() ?? "code").font(.caption).foregroundStyle(.secondary)
				Spacer()
				Button(copied ? "Copied" : "Copy") {
					configuration.codeBlock.copyToPasteboard()
					copied = true
					Task {
						try? await Task.sleep(for: .seconds(1.5))
						copied = false
					}
				}
				.buttonStyle(.borderless)
				.font(.caption)
			}
			.padding(.horizontal, 12)
			.padding(.vertical, 6)
			Divider()
			ScrollView(.horizontal) {
				configuration.label
					.font(.system(size: 12.5, design: .monospaced))
					.lineSpacing(3)
					.fixedSize(horizontal: false, vertical: true)
					.padding(12)
			}
			.scrollIndicators(.automatic)
		}
		.background(Color(nsColor: .textBackgroundColor).opacity(0.6))
		.clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.separator))
		.textual.blockSpacing(.fontScaled(top: 0.8, bottom: 0.2))
	}
}

/// The live end of a turn: what the agent is doing now, its thinking as it streams, and the answer being written.
struct LiveView: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			if session.busy, !session.partial.reasoning.isEmpty, session.partial.text.isEmpty, app.ui.showReasoning {
				Text(tail(session.partial.reasoning))
					.font(.callout)
					.foregroundStyle(.tertiary)
					.lineLimit(3)
					.fixedSize(horizontal: false, vertical: true)
					.transition(.opacity)
			}
			if !session.partial.text.isEmpty {
				MarkdownText(text: session.partial.text)
			}
			if session.busy {
				TimelineView(.periodic(from: .now, by: 1)) { context in
					HStack(spacing: 8) {
						ProgressView().controlSize(.small)
						Text(activityWord).foregroundStyle(.secondary)
						if let started = session.turnStarted {
							Text(durationText(context.date.timeIntervalSince(started))).foregroundStyle(.tertiary).monospacedDigit()
						}
						if let detail = session.status?.detail, !detail.isEmpty {
							Text(detail).foregroundStyle(.tertiary).lineLimit(1)
						}
					}
					.font(.callout)
				}
				.accessibilityElement(children: .combine)
			}
		}
	}

	private var activityWord: String {
		switch session.status?.activity {
		case "thinking": "Thinking"
		case "writing": "Writing"
		case "tool": "Working"
		case "waiting": "Waiting for you"
		case "compacting": "Summarizing older turns"
		case "retrying": "Retrying"
		default: "Working"
		}
	}

	private func tail(_ text: String) -> String {
		text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false).suffix(3).joined(separator: "\n")
	}
}
