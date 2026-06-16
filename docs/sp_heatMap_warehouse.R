# ============================================================
# app.R — Warehouse Velocity Grid (Base R Only)
# Fully commented version
# ============================================================

library(shiny)

# ------------------------------------------------------------
# UI: Controls for grid size, hotspot radius, noise, thresholds
# ------------------------------------------------------------
ui <- fluidPage(
  titlePanel("Warehouse Velocity Grid (Base R) — Fully Commented"),

  sidebarLayout(
    sidebarPanel(
      # Grid dimensions
      sliderInput("nx", "Grid width (X tiles):", 10, 60, 30),
      sliderInput("ny", "Grid height (Y tiles):", 10, 60, 20),

      # Hotspot shape + noise
      sliderInput("radius", "Hotspot radius:", 2, 20, 8),
      sliderInput("noise", "Noise level:", 0, 20, 5),

      # Hot/cold quantile thresholds
      sliderInput("hot_q",  "Hot threshold (quantile):",  0.6, 0.95, 0.80),
      sliderInput("cold_q", "Cold threshold (quantile):", 0.05, 0.4, 0.20)
    ),

    mainPanel(
      tabsetPanel(
        tabPanel("Velocity Heatmap", plotOutput("velocityPlot", height = "600px")),
        tabPanel("Hot / Cold Zones", plotOutput("zonePlot", height = "600px"))
      )
    )
  )
)

# ------------------------------------------------------------
# SERVER LOGIC
# ------------------------------------------------------------
server <- function(input, output) {

  # ----------------------------------------------------------
  # Reactive warehouse grid generator
  # ----------------------------------------------------------
  gridData <- reactive({
    nx <- input$nx
    ny <- input$ny

    # Create grid of tile coordinates
    grid <- expand.grid(x = 1:nx, y = 1:ny)

    # Compute distance from center (for hotspot)
    cx <- (nx + 1) / 2
    cy <- (ny + 1) / 2
    grid$dist <- sqrt((grid$x - cx)^2 + (grid$y - cy)^2)

    # Synthetic velocity field:
    # - Gaussian hotspot in center
    # - Add noise
    grid$velocity <- 100 * exp(-(grid$dist^2) / (2 * input$radius^2)) +
      rnorm(nrow(grid), sd = input$noise)

    # No negative velocities
    grid$velocity <- pmax(grid$velocity, 0)

    # Compute hot/cold thresholds
    hot_t  <- quantile(grid$velocity, input$hot_q)
    cold_t <- quantile(grid$velocity, input$cold_q)

    # Assign zones
    grid$zone <- ifelse(
      grid$velocity >= hot_t, "hot",
      ifelse(grid$velocity <= cold_t, "cold", "normal")
    )

    grid$zone <- factor(grid$zone, levels = c("cold", "normal", "hot"))

    grid
  })

  # ----------------------------------------------------------
  # Helper: Build matrix with rows = x, cols = y
  # image() requires z to have dim = c(length(x), length(y))
  # ----------------------------------------------------------
  build_matrix_xy <- function(df, value_col, nx, ny) {
    # tapply returns matrix indexed by x (rows) and y (cols)
    mat <- tapply(df[[value_col]], list(df$x, df$y), FUN = function(v) v)
    mat <- as.matrix(mat)
    mat[is.na(mat)] <- 0
    mat
  }

  # ----------------------------------------------------------
  # VELOCITY HEATMAP (Base R)
  # ----------------------------------------------------------
  output$velocityPlot <- renderPlot({
    g  <- gridData()
    nx <- input$nx
    ny <- input$ny

    # Build matrix for image()
    mat <- build_matrix_xy(g, "velocity", nx, ny)

    # Customizable color palette
    velocity_colors <- colorRampPalette(
      c("#1B4F72", "#F7F9F9", "#C0392B")
    )(200)

    # Draw heatmap
    image(
      1:nx, 1:ny, mat,
      col = velocity_colors,
      xlab = "", ylab = "",
      axes = FALSE,
      useRaster = TRUE
    )

    # Draw tile borders (aligned to cell centers)
    for (i in 1:nx) {
      for (j in 1:ny) {
        rect(i - 0.5, j - 0.5, i + 0.5, j + 0.5, border = "grey20")
      }
    }
  })

  # ----------------------------------------------------------
  # HOT / COLD ZONE MAP (Base R)
  # ----------------------------------------------------------
  output$zonePlot <- renderPlot({
    g  <- gridData()
    nx <- input$nx
    ny <- input$ny

    # Map zones to integers 1=cold, 2=normal, 3=hot
    zone_idx <- match(g$zone, c("cold", "normal", "hot"))

    # Build matrix for image()
    mat_zone <- tapply(zone_idx, list(g$x, g$y), FUN = function(v) v)
    mat_zone <- as.matrix(mat_zone)

    # Customizable zone colors
    zone_colors <- c(
      cold   = "#21618C",
      normal = "#D5D8DC",
      hot    = "#C0392B"
    )

    # Draw zone map
    image(
      1:nx, 1:ny, mat_zone,
      col = zone_colors,
      xlab = "", ylab = "",
      axes = FALSE,
      useRaster = TRUE
    )

    # Draw tile borders
    for (i in 1:nx) {
      for (j in 1:ny) {
        rect(i - 0.5, j - 0.5, i + 0.5, j + 0.5, border = "grey20")
      }
    }

    # Legend
    legend("topright",
           legend = c("cold", "normal", "hot"),
           fill   = zone_colors,
           bty    = "n")
  })
}

shinyApp(ui, server)
