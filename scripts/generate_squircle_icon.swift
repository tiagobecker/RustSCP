import Foundation
import AppKit
import CoreGraphics

let canvasSize: CGFloat = 1024.0
let tileSize: CGFloat = 824.0
let cornerRadius: CGFloat = 185.0
let tileOrigin = CGPoint(x: (canvasSize - tileSize) / 2.0, y: (canvasSize - tileSize) / 2.0)
let tileRect = CGRect(origin: tileOrigin, size: CGSize(width: tileSize, height: tileSize))

let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let context = CGContext(
    data: nil,
    width: Int(canvasSize),
    height: Int(canvasSize),
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fatalError("Failed to create CGContext")
}

// 1. Ambient drop shadow for the squircle tile
context.saveGState()
let shadowColor = NSColor.black.withAlphaComponent(0.35).cgColor
context.setShadow(offset: CGSize(width: 0, height: -12), blur: 24, color: shadowColor)

let tilePath = CGPath(roundedRect: tileRect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
context.addPath(tilePath)
context.setFillColor(NSColor(calibratedWhite: 0.1, alpha: 1.0).cgColor)
context.fillPath()
context.restoreGState()

// 2. Clip to the squircle path and draw background gradient
context.saveGState()
context.addPath(tilePath)
context.clip()

// Titanium Slate Gradient
let gradientColors = [
    NSColor(calibratedRed: 0.17, green: 0.22, blue: 0.29, alpha: 1.0).cgColor, // #2b384a
    NSColor(calibratedRed: 0.08, green: 0.10, blue: 0.14, alpha: 1.0).cgColor  // #141a24
] as CFArray
let gradientLocations: [CGFloat] = [0.0, 1.0]
if let gradient = CGGradient(colorsSpace: colorSpace, colors: gradientColors, locations: gradientLocations) {
    context.drawLinearGradient(
        gradient,
        start: CGPoint(x: canvasSize / 2.0, y: tileRect.maxY),
        end: CGPoint(x: canvasSize / 2.0, y: tileRect.minY),
        options: []
    )
}

// Subtle metallic radial highlight in the center
let radialColors = [
    NSColor(calibratedRed: 0.28, green: 0.36, blue: 0.48, alpha: 0.35).cgColor,
    NSColor(calibratedRed: 0.0, green: 0.0, blue: 0.0, alpha: 0.0).cgColor
] as CFArray
if let radialGradient = CGGradient(colorsSpace: colorSpace, colors: radialColors, locations: [0.0, 1.0]) {
    context.drawRadialGradient(
        radialGradient,
        startCenter: CGPoint(x: canvasSize / 2.0, y: canvasSize / 2.0),
        startRadius: 0,
        endCenter: CGPoint(x: canvasSize / 2.0, y: canvasSize / 2.0),
        endRadius: tileSize * 0.6,
        options: []
    )
}

// 3. Load emblem from assets/icon.png and draw with drop shadow
if let emblemImage = NSImage(contentsOfFile: "assets/icon.png") {
    var imageRect = CGRect(x: 0, y: 0, width: emblemImage.size.width, height: emblemImage.size.height)
    if let cgEmblem = emblemImage.cgImage(forProposedRect: &imageRect, context: nil, hints: nil) {
        context.saveGState()
        let emblemShadowColor = NSColor.black.withAlphaComponent(0.65).cgColor
        context.setShadow(offset: CGSize(width: 0, height: -10), blur: 20, color: emblemShadowColor)
        
        let emblemPadding: CGFloat = 80.0
        let emblemSize = tileSize - (emblemPadding * 2.0) // ~664px
        let emblemRect = CGRect(
            x: (canvasSize - emblemSize) / 2.0,
            y: (canvasSize - emblemSize) / 2.0,
            width: emblemSize,
            height: emblemSize
        )
        context.draw(cgEmblem, in: emblemRect)
        context.restoreGState()
    }
}

// 4. Subtle inner border / rim highlight
context.addPath(tilePath)
context.setLineWidth(2.5)
context.setStrokeColor(NSColor(calibratedWhite: 1.0, alpha: 0.18).cgColor)
context.strokePath()

context.restoreGState()

// 5. Save output PNG
guard let finalImage = context.makeImage() else {
    fatalError("Failed to create final CGImage")
}

let rep = NSBitmapImageRep(cgImage: finalImage)
guard let pngData = rep.representation(using: .png, properties: [:]) else {
    fatalError("Failed to convert image to PNG")
}

let outputPath = "assets/app-icon-squircle.png"
try pngData.write(to: URL(fileURLWithPath: outputPath))
print("Successfully generated master squircle icon at: \(outputPath)")
